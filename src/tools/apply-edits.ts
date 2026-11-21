import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { runShellCommandAsync } from "../utils/exec-utils.js";
import { readTextFile, resolvePath, toPosixPath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  formatCompactCommandOutput,
  sliceSafeChars,
  truncateWithByteNotice,
} from "../utils/output-filter.js";

export interface EditHunk {
  target: string;
  replacement: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
}

export interface FileEdit {
  path: string;
  hunks?: EditHunk[];
  create?: string;
  overwrite?: boolean;
  delete?: boolean;
  moveTo?: string;
  pruneEmptyDirs?: boolean;
}

export interface VerifySpec {
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface ApplyEditsInput {
  cwd?: string;
  edits: FileEdit[];
  dryRun?: boolean;
  bestEffort?: boolean;
  pruneEmptyDirs?: boolean;
  verify?: string | VerifySpec;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

interface MatchSpan {
  start: number;
  end: number;
  replacement: string;
  hunkIndex: number;
}

interface PlannedWrite {
  kind: "write";
  absPath: string;
  writeTargetPath: string;
  relPath: string;
  existed: boolean;
  originalBuffer: Buffer | null;
  originalMode: number | null;
  originalSymlinkTarget?: string | null;
  newContent: string;
  hunkCount: number;
  lineDelta: number;
  created: boolean;
}

interface PlannedDelete {
  kind: "delete";
  absPath: string;
  sourcePath: string;
  relPath: string;
  pruneEmptyDirs: boolean;
}

interface PlannedMove {
  kind: "move";
  absPath: string;
  sourcePath: string;
  destAbsPath: string;
  destPath: string;
  relPath: string;
  destRelPath: string;
  isCaseOnlySelfRename: boolean;
  destExisted: boolean;
  pruneEmptyDirs: boolean;
  newContent?: string;
  originalMode?: number | null;
  hunkCount?: number;
  lineDelta?: number;
}

type PlannedOp = PlannedWrite | PlannedDelete | PlannedMove;

type UndoAction =
  | { kind: "restore-rename"; from: string; to: string }
  | { kind: "unmove-to-tx"; from: string; to: string }
  | { kind: "unlink-created"; target: string }
  | { kind: "restore-write"; plan: PlannedWrite }
  | { kind: "mkdir"; dir: string };

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function getLineWindowOffsets(
  text: string,
  lineStarts: number[],
  startLine?: number,
  endLine?: number,
): { windowStart: number; windowEnd: number } {
  if (
    startLine !== undefined &&
    (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)
  ) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (
    endLine !== undefined &&
    (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)
  ) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }

  const totalLines = lineStarts.length;
  const sLine = startLine !== undefined ? Math.trunc(startLine) : 1;
  const eLine =
    endLine !== undefined ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;

  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }

  const windowStart = lineStarts[sLine - 1]!;
  const windowEnd =
    eLine < totalLines ? lineStarts[eLine]! : text.length;
  return { windowStart, windowEnd };
}

const MAX_NEARBY_LINES = 26;

function formatNearbyLines(
  text: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = text.split("\n");
  if (startLine === undefined && endLine === undefined) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  const extra = truncated ? `\n    ... (${rawTo - to} more lines in range omitted)` : "";
  return `\n  Nearby lines (${from}-${to}):\n${snippet.join("\n")}${extra}`;
}

function extractLineTokens(trimmedLine: string): string[] {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * Locate the closest matching region in the file (optionally bounded to a
 * 1-based line window) so the caller can fix a mismatched hunk immediately
 * without dumping an 80-line range or doing an extra read_file round-trip.
 */
function findClosestRegionSnippet(
  normalizedContent: string,
  normTarget: string,
  rangeStartLine?: number,
  rangeEndLine?: number,
): string {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";

  const targetLines = normTarget
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";

  const firstAnchor =
    targetLines.find((l) => l.length >= 6) ?? targetLines[0]!;
  let longestAnchor = targetLines[0]!;
  for (const tl of targetLines) {
    if (tl.length > longestAnchor.length) longestAnchor = tl;
  }
  const anchors = [firstAnchor];
  if (longestAnchor !== firstAnchor) anchors.push(longestAnchor);
  const lastAnchor = targetLines[targetLines.length - 1]!;
  if (lastAnchor.length >= 6 && !anchors.includes(lastAnchor)) {
    anchors.push(lastAnchor);
  }

  const primaryTokens = new Set(extractLineTokens(firstAnchor));
  const longestTokens = new Set(extractLineTokens(longestAnchor));
  const trimmedFileLines = fileLines.map((l) => l.trim());

  let bestIdx = -1;
  let bestScore = 0;

  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1,
  );

  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i]!;
    if (!line) continue;

    let score = 0;
    if (line === firstAnchor) {
      score += 10;
    } else if (firstAnchor.length >= 8 && (line.includes(firstAnchor) || firstAnchor.includes(line))) {
      score += 6;
    } else if (primaryTokens.size > 0) {
      const lineTokens = extractLineTokens(line);
      let hits = 0;
      for (const tok of lineTokens) {
        if (primaryTokens.has(tok)) hits += 1;
      }
      if (hits >= 2 || (hits >= 1 && primaryTokens.size <= 2 && hits === primaryTokens.size)) {
        score += 4 * (hits / primaryTokens.size);
      }
    }

    if (longestAnchor !== firstAnchor) {
      if (line === longestAnchor) {
        score += 8;
      } else if (longestAnchor.length >= 10 && line.includes(longestAnchor)) {
        score += 5;
      } else if (longestTokens.size >= 2) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (longestTokens.has(tok)) hits += 1;
        }
        if (hits >= 2) {
          score += 3 * (hits / longestTokens.size);
        }
      }
    }

    // Bonus when nearby subsequent lines also match subsequent target lines
    if (score >= 2 && targetLines.length > 1) {
      const lookahead = Math.min(targetLines.length, 6);
      for (let k = 1; k < lookahead && i + k < trimmedFileLines.length; k++) {
        const nextLine = trimmedFileLines[i + k]!;
        const tgtLine = targetLines[k]!;
        if (nextLine && tgtLine && (nextLine === tgtLine || (tgtLine.length >= 8 && nextLine.includes(tgtLine)))) {
          score += 3;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 2.5) return "";

  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestIdx + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestIdx + 1 + span + 2));
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  return `\n  Closest match near line ${bestIdx + 1} (lines ${from}-${to}):\n${snippet.join("\n")}`;
}

function planHunksForContent(
  normalizedContent: string,
  hunks: EditHunk[],
  displayPath: string,
): { newNormalized: string; appliedMatches: number; errors: string[] } {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans: MatchSpan[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (!isPlainObject(hunk)) {
      errors.push(`${displayPath} hunk #${idx + 1}: must be an object with 'target' and 'replacement'`);
      continue;
    }
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }

    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");

    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine,
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const foundOffsets: number[] = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }

    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== undefined || hunk.endLine !== undefined;
      const rangeNote = hasRange
        ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}`
        : "";
      let hint = "";
      if (hasRange) {
        // Check if exact target exists outside the provided line window (line drift)
        const globalOffsets: number[] = [];
        let gPos = 0;
        while (
          gPos <= normalizedContent.length - normTarget.length &&
          globalOffsets.length < 5
        ) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets
            .map((o) => `L${offsetToLine(lineStarts, o)}`)
            .join(", ");
          hint = ` Exact match found outside range at ${hitLines} — adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint =
              findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) ||
              findClosestRegionSnippet(normalizedContent, normTarget) ||
              formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`,
      );
      continue;
    }

    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets
        .slice(0, 10)
        .map((o) => offsetToLine(lineStarts, o))
        .join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`,
      );
      continue;
    }

    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx,
      });
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const curr = spans[i]!;
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`,
      );
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));

  return {
    newNormalized: pieces.join(""),
    appliedMatches: spans.length,
    errors: [],
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isStrictlyInsideDir(candidatePath: string, rootDir: string): boolean {
  const rel = path.relative(
    normalizeForCompare(rootDir),
    normalizeForCompare(candidatePath),
  );
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isInsideGitDir(candidatePath: string, rootDir: string): boolean {
  const rel = toPosixPath(
    path.relative(normalizeForCompare(rootDir), normalizeForCompare(candidatePath)),
  );
  return rel === ".git" || rel.startsWith(".git/");
}

function isCaseInsensitivePlatform(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

function normalizeEntryName(name: string): string {
  return isCaseInsensitivePlatform() ? name.toLowerCase() : name;
}

/**
 * Resolve all existing ancestor symlinks in the parent chain while preserving
 * the final path component itself so leaf symlinks are not dereferenced when
 * validating delete/move scope.
 */
async function canonicalizePreserveLeaf(absPath: string): Promise<string> {
  const normalized = path.resolve(absPath);
  const parentDir = path.dirname(normalized);
  const leaf = path.basename(normalized);
  if (parentDir === normalized) return normalized;

  const tailSegments: string[] = [leaf];
  let current = parentDir;
  while (true) {
    try {
      const realAncestor = await fs.realpath(current);
      return path.join(realAncestor, ...tailSegments.reverse());
    } catch {
      const next = path.dirname(current);
      if (next === current) {
        return normalized;
      }
      tailSegments.push(path.basename(current));
      current = next;
    }
  }
}

async function writeFileAtomically(params: {
  target: string;
  content: string;
  mode: number | null;
  originalSymlinkTarget?: string | null;
  onCommitted: () => void;
}): Promise<void> {
  const { target, content, mode, originalSymlinkTarget, onCommitted } = params;
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    if (mode !== null && process.platform !== "win32") {
      await fs.chmod(tmpPath, mode);
    }
  } catch (tmpErr) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw tmpErr;
  }

  try {
    await fs.rename(tmpPath, target);
    onCommitted();
  } catch (renameErr) {
    // Fallback if rename across filesystems or directory permissions fails
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    onCommitted();
    if (originalSymlinkTarget) {
      // Replace dangling symlink itself instead of following it on fallback write
      try {
        await fs.unlink(target);
      } catch {
        // ignore unlink failure
      }
    }
    await fs.writeFile(target, content, "utf8");
    if (mode !== null && process.platform !== "win32") {
      try {
        await fs.chmod(target, mode);
      } catch {
        // ignore chmod failure on unsupported filesystems
      }
    }
    void renameErr;
  }
}

function sortDirsDeepestFirst(dirs: Iterable<string>): string[] {
  const unique = new Map<string, string>();
  for (const dir of dirs) {
    const key = normalizeForCompare(dir);
    if (!unique.has(key)) {
      unique.set(key, dir);
    }
  }
  return [...unique.values()].sort((a, b) => {
    const depthDiff =
      toPosixPath(b).split("/").length - toPosixPath(a).split("/").length;
    if (depthDiff !== 0) return depthDiff;
    return b.length - a.length;
  });
}

async function simulatePrunedDirs(
  plans: PlannedOp[],
  realBaseCwd: string,
): Promise<string[]> {
  const candidateStartDirs: string[] = [];
  const populatedDirs = new Set<string>();
  const keptDestKeys = new Set<string>();

  const markAncestorsPopulated = (filePath: string) => {
    keptDestKeys.add(normalizeForCompare(filePath));
    let dir = path.dirname(filePath);
    while (isStrictlyInsideDir(dir, realBaseCwd)) {
      const key = normalizeForCompare(dir);
      if (populatedDirs.has(key)) break;
      populatedDirs.add(key);
      dir = path.dirname(dir);
    }
  };

  for (const plan of plans) {
    if (plan.kind === "write") {
      markAncestorsPopulated(plan.writeTargetPath);
    } else if (plan.kind === "move") {
      markAncestorsPopulated(plan.destPath);
      if (plan.pruneEmptyDirs) {
        candidateStartDirs.push(path.dirname(plan.sourcePath));
      }
    } else if (plan.kind === "delete" && plan.pruneEmptyDirs) {
      candidateStartDirs.push(path.dirname(plan.sourcePath));
    }
  }

  if (candidateStartDirs.length === 0) return [];

  const removedByDir = new Map<string, Set<string>>();
  const markRemoved = (entryPath: string) => {
    const parentKey = normalizeForCompare(path.dirname(entryPath));
    let set = removedByDir.get(parentKey);
    if (!set) {
      set = new Set<string>();
      removedByDir.set(parentKey, set);
    }
    set.add(normalizeEntryName(path.basename(entryPath)));
  };

  for (const plan of plans) {
    if (plan.kind === "delete" || plan.kind === "move") {
      if (!keptDestKeys.has(normalizeForCompare(plan.sourcePath))) {
        markRemoved(plan.sourcePath);
      }
    }
  }

  const prunedDirs: string[] = [];
  const prunedKeys = new Set<string>();

  for (const startDir of sortDirsDeepestFirst(candidateStartDirs)) {
    let current = startDir;
    while (
      isStrictlyInsideDir(current, realBaseCwd) &&
      !isInsideGitDir(current, realBaseCwd)
    ) {
      const key = normalizeForCompare(current);
      if (prunedKeys.has(key)) {
        current = path.dirname(current);
        continue;
      }
      if (populatedDirs.has(key)) break;

      let lst;
      try {
        lst = await fs.lstat(current);
      } catch {
        break;
      }
      if (lst.isSymbolicLink() || !lst.isDirectory()) break;

      let entries: string[];
      try {
        entries = await fs.readdir(current);
      } catch {
        break;
      }

      const removedInThisDir = removedByDir.get(key);
      const allRemoved = entries.every(
        (name) => removedInThisDir?.has(normalizeEntryName(name)) ?? false,
      );
      if (!allRemoved) break;

      prunedKeys.add(key);
      prunedDirs.push(current);
      markRemoved(current);
      current = path.dirname(current);
    }
  }

  return prunedDirs;
}

async function commitPlannedOperations(
  plans: PlannedOp[],
  realBaseCwd: string,
): Promise<{ prunedDirs: string[] }> {
  const undoLog: UndoAction[] = [];
  const sidecarBackups: string[] = [];
  const stagedMoveSources = new Map<PlannedMove, string>();
  const prunedDirs: string[] = [];

  const needsTxDir = plans.some((p) => p.kind === "delete" || p.kind === "move");
  const txDir = path.join(
    realBaseCwd,
    `.agy-fast-tx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let txDirCreated = false;
  let txSeq = 0;

  const ensureTxDir = async () => {
    if (!txDirCreated) {
      await fs.mkdir(txDir, { recursive: true });
      txDirCreated = true;
    }
  };

  const stageMoveOut = async (
    sourcePath: string,
    allowSameDirFallback: boolean,
  ): Promise<string> => {
    await ensureTxDir();
    const txSlot = path.join(txDir, `item-${txSeq++}`);
    try {
      await fs.rename(sourcePath, txSlot);
      undoLog.push({ kind: "restore-rename", from: txSlot, to: sourcePath });
      return txSlot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EXDEV") {
        if (allowSameDirFallback) {
          const localBackup = `${sourcePath}.agy-fast-del-${process.pid}-${Date.now()}-${txSeq++}`;
          await fs.rename(sourcePath, localBackup);
          sidecarBackups.push(localBackup);
          undoLog.push({ kind: "restore-rename", from: localBackup, to: sourcePath });
          return localBackup;
        }
        throw new Error(
          `Cannot atomically stage '${sourcePath}' across filesystems (EXDEV)`,
        );
      }
      throw err;
    }
  };

  try {
    // Stage 1a: Stage deleted files into same-filesystem txDir (O(1), zero-copy)
    if (needsTxDir) {
      for (const plan of plans) {
        if (plan.kind === "delete") {
          await stageMoveOut(plan.sourcePath, !plan.pruneEmptyDirs);
        }
      }

      // Stage 1b: Stage move sources into txDir (handles swaps and case-only renames)
      for (const plan of plans) {
        if (plan.kind === "move") {
          const stagedSrc = await stageMoveOut(plan.sourcePath, false);
          stagedMoveSources.set(plan, stagedSrc);
        }
      }

      // Stage 1c: Stage existing destinations that will be overwritten by moveTo
      for (const plan of plans) {
        if (plan.kind === "move" && plan.destExisted && !plan.isCaseOnlySelfRename) {
          let stillExists = false;
          try {
            await fs.lstat(plan.destPath);
            stillExists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
              throw err;
            }
          }
          if (stillExists) {
            await stageMoveOut(plan.destPath, true);
          }
        }
      }
    }

    // Stage 2a: Materialize move destinations
    for (const plan of plans) {
      if (plan.kind !== "move") continue;
      if (plan.newContent === undefined) {
        await fs.mkdir(path.dirname(plan.destPath), { recursive: true });
        const stagedSrc = stagedMoveSources.get(plan)!;
        await fs.rename(stagedSrc, plan.destPath);
        undoLog.push({ kind: "unmove-to-tx", from: plan.destPath, to: stagedSrc });
      } else {
        await writeFileAtomically({
          target: plan.destPath,
          content: plan.newContent,
          mode: plan.originalMode ?? null,
          onCommitted: () => {
            undoLog.push({ kind: "unlink-created", target: plan.destPath });
          },
        });
      }
    }

    // Stage 2b: Apply standard write/create plans atomically
    for (const plan of plans) {
      if (plan.kind !== "write") continue;
      await writeFileAtomically({
        target: plan.writeTargetPath,
        content: plan.newContent,
        mode: plan.originalMode,
        originalSymlinkTarget: plan.originalSymlinkTarget,
        onCommitted: () => {
          undoLog.push({ kind: "restore-write", plan });
        },
      });
    }

    // Stage 3: Prune empty source parent directories after all writes/moves complete
    const candidateStartDirs: string[] = [];
    for (const plan of plans) {
      if ((plan.kind === "delete" || plan.kind === "move") && plan.pruneEmptyDirs) {
        candidateStartDirs.push(path.dirname(plan.sourcePath));
      }
    }
    const prunedKeys = new Set<string>();
    for (const startDir of sortDirsDeepestFirst(candidateStartDirs)) {
      let current = startDir;
      while (
        isStrictlyInsideDir(current, realBaseCwd) &&
        !isInsideGitDir(current, realBaseCwd)
      ) {
        const key = normalizeForCompare(current);
        if (prunedKeys.has(key)) {
          current = path.dirname(current);
          continue;
        }
        let lst;
        try {
          lst = await fs.lstat(current);
        } catch {
          break;
        }
        if (lst.isSymbolicLink() || !lst.isDirectory()) break;

        let entries: string[];
        try {
          entries = await fs.readdir(current);
        } catch {
          break;
        }
        if (entries.length > 0) break;

        try {
          await fs.rmdir(current);
        } catch (rmdirErr) {
          const code = (rmdirErr as NodeJS.ErrnoException)?.code;
          if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") {
            break;
          }
          throw rmdirErr;
        }
        prunedKeys.add(key);
        prunedDirs.push(current);
        undoLog.push({ kind: "mkdir", dir: current });
        current = path.dirname(current);
      }
    }

    // Stage 4: Commit succeeded — permanently purge staged deletions/backups
    if (txDirCreated) {
      await fs.rm(txDir, { recursive: true, force: true }).catch(() => {});
    }
    for (const backup of sidecarBackups) {
      await fs.unlink(backup).catch(() => {});
    }
    return { prunedDirs };
  } catch (err) {
    // Rollback all committed actions in strict reverse order
    for (let i = undoLog.length - 1; i >= 0; i--) {
      const action = undoLog[i]!;
      try {
        if (action.kind === "mkdir") {
          await fs.mkdir(action.dir, { recursive: true });
        } else if (action.kind === "unlink-created") {
          await fs.unlink(action.target);
        } else if (action.kind === "unmove-to-tx") {
          await fs.mkdir(path.dirname(action.to), { recursive: true });
          await fs.rename(action.from, action.to);
        } else if (action.kind === "restore-rename") {
          await fs.mkdir(path.dirname(action.to), { recursive: true });
          await fs.rename(action.from, action.to);
        } else if (action.kind === "restore-write") {
          const item = action.plan;
          const target = item.writeTargetPath;
          if (item.originalSymlinkTarget) {
            await fs.unlink(target).catch(() => {});
            await fs.symlink(item.originalSymlinkTarget, target);
          } else if (item.existed && item.originalBuffer !== null) {
            await fs.writeFile(target, item.originalBuffer);
            if (item.originalMode !== null && process.platform !== "win32") {
              await fs.chmod(target, item.originalMode);
            }
          } else if (!item.existed) {
            await fs.unlink(target);
          }
        }
      } catch {
        // Best-effort rollback
      }
    }
    // Only remove txDir if completely empty so any un-restored backup is never destroyed
    if (txDirCreated) {
      await fs.rmdir(txDir).catch(() => {});
    }
    throw err;
  }
}

export async function runApplyEdits(
  input: ApplyEditsInput,
): Promise<{ text: string; isError: boolean }> {
  const parsedEdits = parseMaybeJsonArray(input?.edits);
  if (!parsedEdits.ok) {
    if (parsedEdits.kind === "wrong_type" && (typeof input?.edits === "boolean" || input?.edits === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed (0 files modified)",
          toolName: "apply_edits",
          items: [{ label: "edits", value: input.edits, expected: "an array of edit objects" }],
          fallbackAdvice:
            "immediately fall back to parallel built-in edit_file / write_file calls for these file(s).",
        }),
        isError: true,
      };
    }
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true,
    };
  }
  const rawEdits = parsedEdits.value;
  if (rawEdits.length === 0) {
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true,
    };
  }
  if (rawEdits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true,
    };
  }

  // Detect nested-JSON serialization corruption (e.g. edits: [true], [false, true], [null], or hunks: [true])
  // before regular validation so the caller immediately falls back instead of retrying in a loop.
  const corruptedItems: CorruptedItem[] = [];
  const normalizedEdits: FileEdit[] = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i];
    if (!isPlainObject(rawEntry)) {
      corruptedItems.push({ label: `edits[${i}]`, value: rawEntry, expected: "an edit object" });
      continue;
    }
    let normalizedHunks: EditHunk[] | undefined;
    if (rawEntry.hunks !== undefined) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks);
      if (!parsedHunks.ok) {
        corruptedItems.push({
          label: `edits[${i}].hunks`,
          value: rawEntry.hunks,
          expected: "an array of hunk objects",
        });
        continue;
      }
      let hunkCorrupted = false;
      for (let j = 0; j < parsedHunks.value.length; j++) {
        if (!isPlainObject(parsedHunks.value[j])) {
          corruptedItems.push({
            label: `edits[${i}].hunks[${j}]`,
            value: parsedHunks.value[j],
            expected: "a hunk object",
          });
          hunkCorrupted = true;
        }
      }
      if (hunkCorrupted) continue;
      normalizedHunks = parsedHunks.value as unknown as EditHunk[];
    }
    normalizedEdits.push({
      path: rawEntry.path as string,
      hunks: normalizedHunks,
      create: rawEntry.create as string | undefined,
      overwrite: rawEntry.overwrite as boolean | undefined,
      delete: rawEntry.delete as boolean | undefined,
      moveTo: rawEntry.moveTo as string | undefined,
      pruneEmptyDirs: rawEntry.pruneEmptyDirs as boolean | undefined,
    });
  }
  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed (0 files modified)",
        toolName: "apply_edits",
        items: corruptedItems,
        fallbackAdvice:
          "immediately fall back to parallel built-in edit_file / write_file calls for these file(s).",
      }),
      isError: true,
    };
  }

  // Validate optional verify spec up front before touching any files on disk
  let validatedVerify: VerifySpec | null = null;
  if (input.verify !== undefined) {
    if (typeof input.verify === "string") {
      if (input.verify.trim()) {
        validatedVerify = { command: input.verify };
      }
    } else if (isPlainObject(input.verify)) {
      const cmd = input.verify.command;
      if (typeof cmd !== "string" || !cmd.trim()) {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.command' must be a non-empty string.",
          isError: true,
        };
      }
      if (input.verify.cwd !== undefined && typeof input.verify.cwd !== "string") {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.cwd' must be a string.",
          isError: true,
        };
      }
      validatedVerify = {
        command: cmd,
        cwd: input.verify.cwd,
        timeoutSec:
          typeof input.verify.timeoutSec === "number" ? input.verify.timeoutSec : undefined,
      };
    } else {
      return {
        text: "Validation failed (0 files modified):\n- 'verify' must be a command string or { command, cwd?, timeoutSec? } object.",
        isError: true,
      };
    }
  }

  if (input.pruneEmptyDirs !== undefined && typeof input.pruneEmptyDirs !== "boolean") {
    return {
      text: "Validation failed (0 files modified):\n- 'pruneEmptyDirs' must be a boolean.",
      isError: true,
    };
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  let realBaseCwd = baseCwd;
  try {
    realBaseCwd = await fs.realpath(baseCwd);
  } catch {
    // Keep normalized baseCwd if directory doesn't exist yet
  }

  type NormalizedOpItem =
    | {
        kind: "hunks";
        absPath: string;
        writeTargetPath: string;
        relPath: string;
        hunks: EditHunk[];
      }
    | {
        kind: "create";
        absPath: string;
        writeTargetPath: string;
        relPath: string;
        create: string;
        overwrite?: boolean;
      }
    | {
        kind: "delete";
        absPath: string;
        sourcePath: string;
        relPath: string;
        pruneEmptyDirs: boolean;
      }
    | {
        kind: "move";
        absPath: string;
        sourcePath: string;
        destAbsPath: string;
        destPath: string;
        relPath: string;
        destRelPath: string;
        overwrite?: boolean;
        pruneEmptyDirs: boolean;
        hunks: EditHunk[];
      };

  const opItems: NormalizedOpItem[] = [];
  const hunksByTarget = new Map<string, Extract<NormalizedOpItem, { kind: "hunks" }>>();
  const sourceConsumers = new Map<string, NormalizedOpItem>();
  const destWriters = new Map<string, NormalizedOpItem>();
  const errors: string[] = [];

  for (let i = 0; i < normalizedEdits.length; i++) {
    const entry = normalizedEdits[i]!;
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    if (entry.delete !== undefined && typeof entry.delete !== "boolean") {
      errors.push(`edits[${i}]: 'delete' must be a boolean`);
      continue;
    }
    if (entry.moveTo !== undefined && (typeof entry.moveTo !== "string" || !entry.moveTo.trim())) {
      errors.push(`edits[${i}]: 'moveTo' must be a non-empty string`);
      continue;
    }
    if (entry.pruneEmptyDirs !== undefined && typeof entry.pruneEmptyDirs !== "boolean") {
      errors.push(`edits[${i}]: 'pruneEmptyDirs' must be a boolean`);
      continue;
    }
    if (entry.overwrite !== undefined && typeof entry.overwrite !== "boolean") {
      errors.push(`edits[${i}]: 'overwrite' must be a boolean`);
      continue;
    }

    const absPath = resolvePath(entry.path, baseCwd);
    const relPath = toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);
    const hasDelete = entry.delete === true;
    const hasCreate = typeof entry.create === "string";
    const hasMove = typeof entry.moveTo === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;

    if (!hasDelete && !hasCreate && !hasMove && !hasHunks) {
      errors.push(
        `${relPath}: must specify 'hunks', 'create', 'delete: true', or 'moveTo'`,
      );
      continue;
    }
    if (hasDelete && (hasCreate || hasHunks || hasMove)) {
      errors.push(
        `${relPath}: cannot combine 'delete' with 'create', 'hunks', or 'moveTo'`,
      );
      continue;
    }
    if (hasCreate && (hasHunks || hasMove)) {
      errors.push(`${relPath}: cannot specify both 'create' and '${hasMove ? "moveTo" : "hunks"}' on the same entry`);
      continue;
    }

    const effectivePruneEmptyDirs = entry.pruneEmptyDirs ?? input.pruneEmptyDirs ?? false;

    if (hasDelete) {
      const sourcePath = await canonicalizePreserveLeaf(absPath);
      const sourceKey = normalizeForCompare(sourcePath);
      const existingConsumer = sourceConsumers.get(sourceKey);
      if (existingConsumer) {
        errors.push(`${relPath}: duplicate entries cannot mix 'delete' with other edits on the same file`);
        continue;
      }
      const item: NormalizedOpItem = {
        kind: "delete",
        absPath,
        sourcePath,
        relPath,
        pruneEmptyDirs: effectivePruneEmptyDirs,
      };
      sourceConsumers.set(sourceKey, item);
      opItems.push(item);
      continue;
    }

    if (hasMove) {
      const sourcePath = await canonicalizePreserveLeaf(absPath);
      const destAbsPath = resolvePath(entry.moveTo!, baseCwd);
      const destPath = await canonicalizePreserveLeaf(destAbsPath);
      const destRelPath =
        toPosixPath(path.relative(baseCwd, destAbsPath)) || path.basename(destAbsPath);
      const sourceKey = normalizeForCompare(sourcePath);
      const destKey = normalizeForCompare(destPath);

      if (sourceConsumers.has(sourceKey)) {
        errors.push(
          `${relPath}: duplicate source entry for 'moveTo' (combine 'hunks' and 'moveTo' on the same entry)`,
        );
        continue;
      }
      if (destWriters.has(destKey)) {
        errors.push(`${destRelPath}: duplicate destination path across entries`);
        continue;
      }

      const item: NormalizedOpItem = {
        kind: "move",
        absPath,
        sourcePath,
        destAbsPath,
        destPath,
        relPath,
        destRelPath,
        overwrite: entry.overwrite,
        pruneEmptyDirs: effectivePruneEmptyDirs,
        hunks: hasHunks ? [...entry.hunks!] : [],
      };
      sourceConsumers.set(sourceKey, item);
      destWriters.set(destKey, item);
      opItems.push(item);
      continue;
    }

    let writeTargetPath = absPath;
    try {
      // Canonicalize existing paths (including symlinks and symlinked parent dirs like /var -> /private/var)
      writeTargetPath = await fs.realpath(absPath);
    } catch {
      // File does not exist yet or dangling symlink — still canonicalize existing parent dir
      // so `sym_dir/new.ts` and `real_dir/new.ts` deduplicate cleanly.
      try {
        const realParent = await fs.realpath(path.dirname(absPath));
        writeTargetPath = path.join(realParent, path.basename(absPath));
      } catch {
        // Parent directory does not exist yet — keep absPath
      }
    }
    const targetKey = normalizeForCompare(writeTargetPath);

    if (hasCreate) {
      const existingDest = destWriters.get(targetKey);
      if (existingDest) {
        errors.push(
          existingDest.kind === "hunks" || existingDest.kind === "create"
            ? `${relPath}: duplicate entries cannot mix 'create' with other edits`
            : `${relPath}: duplicate destination path across entries`,
        );
        continue;
      }
      const item: NormalizedOpItem = {
        kind: "create",
        absPath,
        writeTargetPath,
        relPath,
        create: entry.create!,
        overwrite: entry.overwrite,
      };
      destWriters.set(targetKey, item);
      opItems.push(item);
      continue;
    }

    // Standard hunks entry (merge multiple hunks entries targeting the same resolved file)
    const existingHunks = hunksByTarget.get(targetKey);
    if (existingHunks) {
      existingHunks.hunks.push(...entry.hunks!);
      continue;
    }
    const existingDest = destWriters.get(targetKey);
    if (existingDest) {
      errors.push(
        existingDest.kind === "create"
          ? `${relPath}: duplicate entries cannot mix 'create' with other edits`
          : `${relPath}: duplicate destination path across entries`,
      );
      continue;
    }
    const existingConsumer = sourceConsumers.get(targetKey);
    if (existingConsumer) {
      errors.push(
        `${relPath}: cannot edit a file that is also being deleted or moved in the same batch`,
      );
      continue;
    }
    const item: Extract<NormalizedOpItem, { kind: "hunks" }> = {
      kind: "hunks",
      absPath,
      writeTargetPath,
      relPath,
      hunks: [...entry.hunks!],
    };
    hunksByTarget.set(targetKey, item);
    sourceConsumers.set(targetKey, item);
    destWriters.set(targetKey, item);
    opItems.push(item);
  }

  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):\n- ${errors.join("\n- ")}`,
      isError: true,
    };
  }

  // Phase 1a: Validate sources, scope boundaries, and in-memory hunk plans
  interface PendingCreate {
    kind: "pending-create";
    item: Extract<NormalizedOpItem, { kind: "create" }>;
    exists: boolean;
    isDanglingSymlink: boolean;
    originalBuffer: Buffer | null;
    originalMode: number | null;
    originalSymlinkTarget: string | null;
  }

  interface PendingMove {
    kind: "pending-move";
    item: Extract<NormalizedOpItem, { kind: "move" }>;
    isCaseOnlySelfRename: boolean;
    destExists: boolean;
    newContent?: string;
    originalMode?: number | null;
    hunkCount?: number;
    lineDelta?: number;
  }

  const readyPlans: PlannedOp[] = [];
  const pendingCreates: PendingCreate[] = [];
  const pendingMoves: PendingMove[] = [];

  for (const item of opItems) {
    if (item.kind === "delete") {
      if (!isStrictlyInsideDir(item.sourcePath, realBaseCwd)) {
        errors.push(
          `${item.relPath}: delete path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`,
        );
        continue;
      }
      if (isInsideGitDir(item.sourcePath, realBaseCwd)) {
        errors.push(`${item.relPath}: refusing to delete files inside '.git'`);
        continue;
      }
      let lst;
      try {
        lst = await fs.lstat(item.sourcePath);
      } catch (err) {
        errors.push(
          `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (lst.isDirectory()) {
        errors.push(
          `${item.relPath}: target path is a directory ('delete' only removes files/symlinks; use pruneEmptyDirs: true to remove empty parent directories)`,
        );
        continue;
      }
      readyPlans.push({
        kind: "delete",
        absPath: item.absPath,
        sourcePath: item.sourcePath,
        relPath: item.relPath,
        pruneEmptyDirs: item.pruneEmptyDirs,
      });
      continue;
    }

    if (item.kind === "move") {
      if (!isStrictlyInsideDir(item.sourcePath, realBaseCwd)) {
        errors.push(
          `${item.relPath}: move source path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`,
        );
        continue;
      }
      if (!isStrictlyInsideDir(item.destPath, realBaseCwd)) {
        errors.push(
          `${item.destRelPath}: move destination path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`,
        );
        continue;
      }
      if (isInsideGitDir(item.sourcePath, realBaseCwd) || isInsideGitDir(item.destPath, realBaseCwd)) {
        errors.push(`${item.relPath}: refusing to move files into or out of '.git'`);
        continue;
      }
      if (item.sourcePath === item.destPath) {
        errors.push(`${item.relPath}: move source and destination resolve to the same path`);
        continue;
      }
      const isCaseOnlySelfRename =
        isCaseInsensitivePlatform() &&
        normalizeForCompare(item.sourcePath) === normalizeForCompare(item.destPath) &&
        item.sourcePath !== item.destPath;

      let srcLstat;
      try {
        srcLstat = await fs.lstat(item.sourcePath);
      } catch (err) {
        errors.push(
          `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (srcLstat.isDirectory()) {
        errors.push(
          `${item.relPath}: move source is a directory ('moveTo' only moves files/symlinks)`,
        );
        continue;
      }

      let newContent: string | undefined;
      let originalMode: number | null | undefined;
      let hunkCount: number | undefined;
      let lineDelta: number | undefined;

      if (item.hunks.length > 0) {
        if (srcLstat.isSymbolicLink()) {
          errors.push(
            `${item.relPath}: cannot combine 'moveTo' with 'hunks' on a symbolic link`,
          );
          continue;
        }
        let fileData;
        try {
          fileData = await readTextFile(item.sourcePath);
        } catch (err) {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
        const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
        if (planned.errors.length > 0) {
          errors.push(...planned.errors);
          continue;
        }
        newContent =
          fileData.eol === "\r\n"
            ? planned.newNormalized.replace(/\n/g, "\r\n")
            : planned.newNormalized;
        originalMode = fileData.mode;
        hunkCount = planned.appliedMatches;
        lineDelta = countLines(planned.newNormalized) - countLines(normalizedOriginal);
      }

      let destExists = false;
      if (!isCaseOnlySelfRename) {
        try {
          const destLst = await fs.lstat(item.destPath);
          if (destLst.isDirectory()) {
            errors.push(`${item.destRelPath}: move destination path is a directory`);
            continue;
          }
          if (destLst.isSymbolicLink()) {
            try {
              const destSt = await fs.stat(item.destPath);
              if (destSt.isDirectory()) {
                errors.push(`${item.destRelPath}: move destination path is a directory`);
                continue;
              }
            } catch (statErr) {
              if ((statErr as NodeJS.ErrnoException)?.code !== "ENOENT") {
                errors.push(
                  `${item.destRelPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
                );
                continue;
              }
            }
          }
          destExists = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            errors.push(
              `${item.destRelPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
      }

      pendingMoves.push({
        kind: "pending-move",
        item,
        isCaseOnlySelfRename,
        destExists,
        newContent,
        originalMode,
        hunkCount,
        lineDelta,
      });
      continue;
    }

    if (item.kind === "create") {
      let exists = false;
      let isDanglingSymlink = false;
      let originalBuffer: Buffer | null = null;
      let originalMode: number | null = null;
      let originalSymlinkTarget: string | null = null;
      try {
        const lst = await fs.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs.stat(item.writeTargetPath);
            if (st.isDirectory()) {
              errors.push(`${item.relPath}: target path is a directory`);
              continue;
            }
            exists = true;
            originalMode = st.mode & 0o7777;
            originalBuffer = await fs.readFile(item.writeTargetPath);
          } catch (statErr) {
            if ((statErr as NodeJS.ErrnoException)?.code === "ENOENT") {
              exists = true;
              isDanglingSymlink = true;
              originalSymlinkTarget = await fs.readlink(item.writeTargetPath);
            } else {
              errors.push(
                `${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
              );
              continue;
            }
          }
        } else {
          const st = await fs.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: target path is a directory`);
            continue;
          }
          exists = true;
          originalMode = st.mode & 0o7777;
          originalBuffer = await fs.readFile(item.writeTargetPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          exists = false;
          originalBuffer = null;
          originalMode = null;
        } else {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      pendingCreates.push({
        kind: "pending-create",
        item,
        exists,
        isDanglingSymlink,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
      });
      continue;
    }

    // Existing file hunks
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }

    const finalContent =
      fileData.eol === "\r\n"
        ? planned.newNormalized.replace(/\n/g, "\r\n")
        : planned.newNormalized;

    const lineDelta =
      countLines(planned.newNormalized) - countLines(normalizedOriginal);

    readyPlans.push({
      kind: "write",
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent: finalContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
    });
  }

  // Phase 1b: Fixed-point resolution of vacated paths for moveTo & create overwrite checks
  let survivingMoves = pendingMoves;
  while (true) {
    const vacatedKeys = new Set<string>();
    for (const p of readyPlans) {
      if (p.kind === "delete") {
        vacatedKeys.add(normalizeForCompare(p.sourcePath));
      }
    }
    for (const m of survivingMoves) {
      vacatedKeys.add(normalizeForCompare(m.item.sourcePath));
    }

    const nextMoves: PendingMove[] = [];
    let dropped = false;
    for (const m of survivingMoves) {
      if (
        m.destExists &&
        !m.isCaseOnlySelfRename &&
        !vacatedKeys.has(normalizeForCompare(m.item.destPath)) &&
        !m.item.overwrite
      ) {
        errors.push(
          `${m.item.destRelPath}: move destination already exists (set overwrite: true to replace it)`,
        );
        dropped = true;
      } else {
        nextMoves.push(m);
      }
    }
    survivingMoves = nextMoves;
    if (!dropped) break;
  }

  const finalVacatedKeys = new Set<string>();
  for (const p of readyPlans) {
    if (p.kind === "delete") {
      finalVacatedKeys.add(normalizeForCompare(p.sourcePath));
    }
  }
  for (const m of survivingMoves) {
    finalVacatedKeys.add(normalizeForCompare(m.item.sourcePath));
  }

  const plans: PlannedOp[] = [...readyPlans];

  for (const m of survivingMoves) {
    const destVacated = finalVacatedKeys.has(normalizeForCompare(m.item.destPath));
    plans.push({
      kind: "move",
      absPath: m.item.absPath,
      sourcePath: m.item.sourcePath,
      destAbsPath: m.item.destAbsPath,
      destPath: m.item.destPath,
      relPath: m.item.relPath,
      destRelPath: m.item.destRelPath,
      isCaseOnlySelfRename: m.isCaseOnlySelfRename,
      destExisted: m.destExists && !destVacated,
      pruneEmptyDirs: m.item.pruneEmptyDirs,
      newContent: m.newContent,
      originalMode: m.originalMode,
      hunkCount: m.hunkCount,
      lineDelta: m.lineDelta,
    });
  }

  for (const c of pendingCreates) {
    const targetVacated = finalVacatedKeys.has(normalizeForCompare(c.item.writeTargetPath));
    if (c.exists && !targetVacated && !c.item.overwrite) {
      errors.push(
        c.isDanglingSymlink
          ? `${c.item.relPath}: dangling symlink already exists (set overwrite: true to replace it)`
          : `${c.item.relPath}: file already exists (set overwrite: true to replace it)`,
      );
      continue;
    }
    const effectiveExisted = c.exists && !targetVacated;
    const effectiveOrigBuf = effectiveExisted ? c.originalBuffer : null;
    const oldLines = effectiveOrigBuf ? countLines(effectiveOrigBuf.toString("utf8")) : 0;
    const newLines = countLines(c.item.create);
    plans.push({
      kind: "write",
      absPath: c.item.absPath,
      writeTargetPath: c.item.writeTargetPath,
      relPath: c.item.relPath,
      existed: effectiveExisted,
      originalBuffer: effectiveOrigBuf,
      originalMode: effectiveExisted ? c.originalMode : null,
      originalSymlinkTarget: effectiveExisted ? c.originalSymlinkTarget : null,
      newContent: c.item.create,
      hunkCount: 1,
      lineDelta: newLines - oldLines,
      created: !effectiveExisted,
    });
  }

  const bestEffort = Boolean(input.bestEffort);

  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort
      ? "Edit aborted (0 files modified):"
      : "Atomic edit aborted (0 files modified):";
    return {
      text: truncateWithByteNotice(
        `${prefix}\n- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES,
      ),
      isError: true,
    };
  }

  // Phase 2: commit planned operations (or simulate pruned dirs in dryRun)
  let prunedDirs: string[] = [];
  if (!input.dryRun) {
    try {
      const committed = await commitPlannedOperations(plans, realBaseCwd);
      prunedDirs = committed.prunedDirs;
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  } else {
    prunedDirs = await simulatePrunedDirs(plans, realBaseCwd);
  }

  const summaryLines = plans.map((p) => {
    if (p.kind === "delete") {
      return `- ${p.relPath}: deleted`;
    }
    if (p.kind === "move") {
      if (p.newContent !== undefined) {
        const delta = p.lineDelta ?? 0;
        const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
        const matches = p.hunkCount ?? 0;
        return `- ${p.relPath} -> ${p.destRelPath}: moved & updated (${matches} match${matches === 1 ? "" : "es"}), lines ${deltaStr}`;
      }
      return `- ${p.relPath} -> ${p.destRelPath}: moved`;
    }
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created
      ? "created"
      : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });

  const prunedRelPaths = prunedDirs.map(
    (d) => toPosixPath(path.relative(realBaseCwd, d)) || path.basename(d),
  );
  const prunedNotice =
    prunedRelPaths.length > 0
      ? `${input.dryRun ? "Would prune" : "Pruned"} empty dir(s): ${prunedRelPaths.join(", ")}`
      : null;

  if (bestEffort && errors.length > 0) {
    const totalFiles = opItems.length;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const partialHeader = input.dryRun
      ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):`
      : `Partial edit applied (${plans.length}/${totalFiles} file(s) written; ${failedFileCount} file(s) failed — do NOT re-send applied files):`;
    const appliedBody = prunedNotice
      ? `Applied:\n${summaryLines.join("\n")}\n${prunedNotice}`
      : `Applied:\n${summaryLines.join("\n")}`;
    const partialParts = [
      partialHeader,
      appliedBody,
      `Failed (fix only these):\n- ${errors.join("\n- ")}`,
    ];
    if (!input.dryRun && input.verify) {
      partialParts.push(
        "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify.",
      );
    }
    return {
      text: truncateWithByteNotice(
        partialParts.join("\n\n"),
        DEFAULT_INLINE_MAX_BYTES,
      ),
      isError: true,
    };
  }

  const header = input.dryRun
    ? `Dry run validated ${plans.length} file(s) (0 files modified):`
    : `Applied edits to ${plans.length} file(s):`;
  const parts = [
    prunedNotice
      ? `${header}\n${summaryLines.join("\n")}\n${prunedNotice}`
      : `${header}\n${summaryLines.join("\n")}`,
  ];

  // Phase 3: optional inline verify
  if (!input.dryRun && validatedVerify) {
    const verifySpec = validatedVerify;
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const rawTimeoutSec = Number(verifySpec.timeoutSec ?? input.verifyTimeoutSec ?? 60);
    const timeoutMs =
      (Number.isFinite(rawTimeoutSec)
        ? Math.max(1, Math.min(300, Math.trunc(rawTimeoutSec)))
        : 60) * 1000;
    const rawMaxVerifyChars = Number(input.maxVerifyChars ?? 4000);
    const maxVerifyChars = Number.isFinite(rawMaxVerifyChars)
      ? Math.max(300, Math.min(7_500, Math.trunc(rawMaxVerifyChars)))
      : 4000;

    const res = await runShellCommandAsync(verifySpec.command, {
      cwd: verifyCwd,
      timeoutMs,
    });

    const status = res.timedOut
      ? "TIMEOUT"
      : res.exitCode === 0
        ? "PASS"
        : `FAIL (exit ${res.exitCode ?? "err"})`;
    const formatted = formatCompactCommandOutput({
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      error: res.error,
      maxChars: maxVerifyChars,
    });

    parts.push(
      `\nVerify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:\n${formatted}`,
    );
  }

  const outText = parts.join("\n");
  const finalText = truncateWithByteNotice(outText, DEFAULT_INLINE_MAX_BYTES);
  return { text: finalText, isError: false };
}
