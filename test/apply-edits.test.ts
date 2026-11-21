import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runApplyEdits } from "../src/tools/apply-edits.js";

describe("apply_edits", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-fast-edits-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies multiple non-contiguous hunks across multiple files atomically", async () => {
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    await fs.writeFile(
      fileA,
      ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;"].join("\n"),
      "utf8",
    );
    await fs.writeFile(fileB, "export const flag = false;\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "a.ts",
          hunks: [
            { target: "const a = 1;", replacement: "const a = 10;" },
            { target: "const d = 4;", replacement: "const d = 40;" },
          ],
        },
        {
          path: "b.ts",
          hunks: [
            { target: "flag = false", replacement: "flag = true" },
          ],
        },
        {
          path: "nested/created.txt",
          create: "hello new file\n",
        },
      ],
    });

    assert.equal(res.isError, false);
    assert.equal(
      await fs.readFile(fileA, "utf8"),
      ["const a = 10;", "const b = 2;", "const c = 3;", "const d = 40;"].join("\n"),
    );
    assert.equal(await fs.readFile(fileB, "utf8"), "export const flag = true;\n");
    assert.equal(
      await fs.readFile(path.join(tmpDir, "nested", "created.txt"), "utf8"),
      "hello new file\n",
    );
  });

  it("modifies zero files when any hunk fails across any file (all-or-nothing)", async () => {
    const goodFile = path.join(tmpDir, "good.txt");
    const badFile = path.join(tmpDir, "bad.txt");
    await fs.writeFile(goodFile, "original good\n", "utf8");
    await fs.writeFile(badFile, "original bad\n", "utf8");

    const res = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "good.txt",
          hunks: [{ target: "original good", replacement: "MODIFIED GOOD" }],
        },
        {
          path: "bad.txt",
          hunks: [{ target: "nonexistent text", replacement: "nope" }],
        },
      ],
    });

    assert.equal(res.isError, true);
    assert.match(res.text, /0 files modified/);
    assert.equal(await fs.readFile(goodFile, "utf8"), "original good\n");
    assert.equal(await fs.readFile(badFile, "utf8"), "original bad\n");
  });

  it("uses startLine/endLine to disambiguate duplicate text and rejects ambiguous matches", async () => {
    const dupFile = path.join(tmpDir, "dup.ts");
    await fs.writeFile(
      dupFile,
      [
        "function one() {",
        "  return value;",
        "}",
        "function two() {",
        "  return value;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const ambig = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [{ target: "return value;", replacement: "return 2;" }],
        },
      ],
    });
    assert.equal(ambig.isError, true);
    assert.match(ambig.text, /matched 2 times \(lines: 2, 5\)/);

    const anchored = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "dup.ts",
          hunks: [
            {
              target: "return value;",
              replacement: "return 2;",
              startLine: 4,
              endLine: 6,
            },
          ],
        },
      ],
    });
    assert.equal(anchored.isError, false);
    const updated = await fs.readFile(dupFile, "utf8");
    assert.match(updated, /one\(\) \{\n  return value;/);
    assert.match(updated, /two\(\) \{\n  return 2;/);
  });

  it("supports replaceAll, merges duplicate file entries, and rejects overlapping hunks", async () => {
    const f = path.join(tmpDir, "merge.txt");
    await fs.writeFile(f, "alpha beta alpha gamma\n", "utf8");

    const overlap = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [
            { target: "alpha beta", replacement: "X" },
            { target: "beta alpha", replacement: "Y" },
          ],
        },
      ],
    });
    assert.equal(overlap.isError, true);
    assert.match(overlap.text, /overlap/);

    const merged = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "merge.txt",
          hunks: [{ target: "alpha", replacement: "ALPHA", replaceAll: true }],
        },
        {
          path: "merge.txt",
          hunks: [{ target: "gamma", replacement: "GAMMA" }],
        },
      ],
    });
    assert.equal(merged.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "ALPHA beta ALPHA GAMMA\n");
  });

  it("preserves CRLF line endings and supports dryRun", async () => {
    const crlfFile = path.join(tmpDir, "win.txt");
    await fs.writeFile(crlfFile, "line1\r\nline2\r\nline3\r\n", "utf8");

    const dry = await runApplyEdits({
      cwd: tmpDir,
      dryRun: true,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(dry.isError, false);
    assert.match(dry.text, /Dry run/);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "line1\r\nline2\r\nline3\r\n");

    const real = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "win.txt",
          hunks: [{ target: "line1\nline2", replacement: "LINE1\nLINE2" }],
        },
      ],
    });
    assert.equal(real.isError, false);
    assert.equal(await fs.readFile(crlfFile, "utf8"), "LINE1\r\nLINE2\r\nline3\r\n");
  });

  it("runs inline verify command on pass and fail", async () => {
    const f = path.join(tmpDir, "check.js");
    await fs.writeFile(f, "const x = 1;\n", "utf8");

    const passRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 1", replacement: "x = 2" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.log('12 tests passed')"`,
    });
    assert.equal(passRes.isError, false);
    assert.match(passRes.text, /Verify \[PASS/);
    assert.match(passRes.text, /12 tests passed/);

    const failRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "check.js", hunks: [{ target: "x = 2", replacement: "x = 3" }] },
      ],
      verify: `${JSON.stringify(process.execPath)} -e "console.error('TypeError: bad value'); process.exit(1)"`,
    });
    assert.equal(failRes.isError, false);
    assert.match(failRes.text, /Verify \[FAIL \(exit 1\)/);
    assert.match(failRes.text, /TypeError: bad value/);
    assert.equal(await fs.readFile(f, "utf8"), "const x = 3;\n");
  });

  it("refuses overwriting existing file with create unless overwrite is true", async () => {
    const f = path.join(tmpDir, "exist.txt");
    await fs.writeFile(f, "keep me\n", "utf8");

    const blocked = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "new\n" }],
    });
    assert.equal(blocked.isError, true);
    assert.equal(await fs.readFile(f, "utf8"), "keep me\n");

    const allowed = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "exist.txt", create: "replaced\n", overwrite: true }],
    });
    assert.equal(allowed.isError, false);
    assert.equal(await fs.readFile(f, "utf8"), "replaced\n");
  });

  it("preserves file permissions, follows symlinks, reports accurate line counts, and validates line bounds", async () => {
    const scriptPath = path.join(tmpDir, "tool.sh");
    await fs.writeFile(scriptPath, "#!/bin/sh\necho v1\n", "utf8");
    if (process.platform !== "win32") {
      await fs.chmod(scriptPath, 0o755);
    }

    const realFile = path.join(tmpDir, "real-target.txt");
    const symFile = path.join(tmpDir, "sym-link.txt");
    await fs.writeFile(realFile, "hello link\n", "utf8");
    await fs.symlink(realFile, symFile);

    const editRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        { path: "tool.sh", hunks: [{ target: "v1", replacement: "v2" }] },
        { path: "sym-link.txt", hunks: [{ target: "hello", replacement: "updated" }] },
        { path: "real-target.txt", hunks: [{ target: "link", replacement: "target" }] },
        { path: "single-line.txt", create: "only one line\n" },
      ],
    });

    assert.equal(editRes.isError, false);
    assert.match(editRes.text, /single-line\.txt: created, lines \+1/);
    assert.equal(await fs.readFile(scriptPath, "utf8"), "#!/bin/sh\necho v2\n");
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(scriptPath)).mode & 0o777, 0o755);
    }
    assert.equal((await fs.lstat(symFile)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(realFile, "utf8"), "updated target\n");

    const badLine = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "real-target.txt",
          hunks: [{ target: "updated", replacement: "x", startLine: Number.NaN }],
        },
      ],
    });
    assert.equal(badLine.isError, true);
    assert.match(badLine.text, /Invalid startLine/);
  });

  it("rolls back content and permissions if a later write fails in Phase 2", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const okPath = path.join(tmpDir, "rb-ok.sh");
    const lockedDir = path.join(tmpDir, "rb-locked");
    const lockedFile = path.join(lockedDir, "blocked.txt");
    await fs.mkdir(lockedDir, { recursive: true });
    await fs.writeFile(okPath, "#!/bin/sh\necho orig\n", "utf8");
    await fs.chmod(okPath, 0o755);
    await fs.writeFile(lockedFile, "locked orig\n", "utf8");
    await fs.chmod(lockedFile, 0o444);
    await fs.chmod(lockedDir, 0o555);

    try {
      const res = await runApplyEdits({
        cwd: tmpDir,
        edits: [
          { path: "rb-ok.sh", hunks: [{ target: "orig", replacement: "changed" }] },
          { path: "rb-locked/blocked.txt", hunks: [{ target: "orig", replacement: "changed" }] },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /rolled back/);
      assert.equal(await fs.readFile(okPath, "utf8"), "#!/bin/sh\necho orig\n");
      assert.equal((await fs.stat(okPath)).mode & 0o777, 0o755);
    } finally {
      await fs.chmod(lockedDir, 0o755);
      await fs.chmod(lockedFile, 0o644);
    }
  });

  it("includes closest-match line snippets when target misses without startLine/endLine and supports bestEffort partial commits", async () => {
    const okFile = path.join(tmpDir, "be-ok.java");
    const missFile = path.join(tmpDir, "be-miss.java");
    await fs.writeFile(okFile, "public class Ok {\n  int value = 1;\n}\n", "utf8");
    await fs.writeFile(
      missFile,
      [
        "public class ShopIncome {",
        "  public static String label(String source) {",
        "    return switch (source) {",
        '      case "ERP" -> "实付";',
        '      case "EST" -> "估算";',
        '      default -> "未知";',
        "    };",
        "  }",
        "}",
      ].join("\n") + "\n",
      "utf8",
    );

    // Without startLine/endLine, atomic mode still reports closest match snippet
    const atomicMiss = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "be-miss.java",
          hunks: [
            {
              target: '    return switch (source) {\n      case "ERP" -> "WRONG";\n    };',
              replacement: "    return source;",
            },
          ],
        },
      ],
    });
    assert.equal(atomicMiss.isError, true);
    assert.match(atomicMiss.text, /Closest match near line 3/);
    assert.match(atomicMiss.text, /case "ERP" -> "实付"/);

    // bestEffort: true writes valid files, keeps failed file intact with snippet, and skips verify
    const partial = await runApplyEdits({
      cwd: tmpDir,
      bestEffort: true,
      verify: `${JSON.stringify(process.execPath)} -e "console.log('SHOULD_NOT_RUN')"`,
      edits: [
        {
          path: "be-ok.java",
          hunks: [{ target: "int value = 1;", replacement: "int value = 2;" }],
        },
        {
          path: "be-miss.java",
          hunks: [
            {
              target: '    return switch (source) {\n      case "ERP" -> "WRONG";\n    };',
              replacement: "    return source;",
            },
          ],
        },
      ],
    });
    assert.equal(partial.isError, true);
    assert.match(partial.text, /Partial edit applied \(1\/2 file\(s\) written; 1 file\(s\) failed/);
    assert.match(partial.text, /be-ok\.java: updated/);
    assert.match(partial.text, /Closest match near line 3/);
    assert.match(partial.text, /Verify skipped/);
    assert.doesNotMatch(partial.text, /SHOULD_NOT_RUN/);
    assert.equal(await fs.readFile(okFile, "utf8"), "public class Ok {\n  int value = 2;\n}\n");
    assert.match(await fs.readFile(missFile, "utf8"), /case "ERP" -> "实付"/);
  });

  it("detects line-drifted exact matches, bounds wide-range failure snippets, and filters Spring/Pino verify noise", async () => {
    const bigPath = path.join(tmpDir, "drift.ts");
    const lines = [
      ...Array.from({ length: 85 }, (_, i) => `const filler_${i + 1} = ${i + 1};`),
      "function targetBlock() {",
      "  const answer = 42;",
      "  return answer;",
      "}",
    ];
    await fs.writeFile(bigPath, lines.join("\n") + "\n", "utf8");

    // 1. Exact target exists outside startLine..endLine -> reports exact drifted line
    const driftRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 40,
              target: "function targetBlock() {\n  const answer = 42;",
              replacement: "function targetBlock() {\n  const answer = 99;",
            },
          ],
        },
      ],
    });
    assert.equal(driftRes.isError, true);
    assert.match(driftRes.text, /Exact match found outside range at L86/);

    // 2. Wide range (>26 lines) mismatch uses closest-region snippet instead of dumping 85 lines
    const wideRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [
        {
          path: "drift.ts",
          hunks: [
            {
              startLine: 1,
              endLine: 89,
              target: "function targetBlock() {\n  const answer = 999;",
              replacement: "function targetBlock() {\n  const answer = 100;",
            },
          ],
        },
      ],
    });
    assert.equal(wideRes.isError, true);
    assert.match(wideRes.text, /Closest match near line 86/);
    assert.ok(wideRes.text.length < 1500, `Expected compact hint, got ${wideRes.text.length} chars`);

    // 3. Verify compact output strips Pino level:30 JSON noise + Maven Help footer and preserves Spring Description + Caused by
    const noisyVerifyScript = [
      'for (let i = 0; i < 80; i++) console.log(JSON.stringify({ level: 30, msg: "incoming request", reqId: i, payload: "x".repeat(60) }));',
      'console.log("Description:");',
      'console.log("Parameter 1 of constructor in AfterSaleController required a bean of type AfterSaleQueryService.");',
      'console.log("Action:");',
      'console.log("Consider defining a bean of type AfterSaleQueryService.");',
      'for (let i = 0; i < 40; i++) console.log("    at com.example.Framework.invoke(Framework.java:" + i + ")");',
      'console.log("Caused by: java.sql.SQLSyntaxErrorException: Unknown column shop_avatar");',
      'console.log("[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.");',
      'console.log("[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException");',
      "process.exit(1);",
    ].join(" ");
    const verifyRes = await runApplyEdits({
      cwd: tmpDir,
      maxVerifyChars: 20_000,
      verify: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(noisyVerifyScript)}`,
      edits: [
        {
          path: "drift.ts",
          hunks: [{ target: "const filler_1 = 1;", replacement: "const filler_1 = 10;" }],
        },
      ],
    });
    const verifyBody = verifyRes.text.split("`:\n")[1] ?? "";
    assert.equal(verifyRes.isError, false);
    assert.ok(Buffer.byteLength(verifyRes.text, "utf8") <= 8_800);
    assert.match(verifyBody, /AfterSaleQueryService/);
    assert.match(verifyBody, /Caused by: java\.sql\.SQLSyntaxErrorException/);
    assert.doesNotMatch(verifyBody, /incoming request/);
    assert.doesNotMatch(verifyBody, /\[Help 1\]/);
  });

  it("circuit-breaks corrupted call_mcp_tool nested edits (booleans/null) and accepts stringified JSON arrays", async () => {
    const file = path.join(tmpDir, "corrupt-test.ts");
    await fs.writeFile(file, "export const x = 1;\n", "utf8");

    // Client serialization bug: edits collapsed to [false, true] or [null]
    const boolRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [false, true] as unknown as never[],
    });
    assert.equal(boolRes.isError, true);
    assert.match(boolRes.text, /nested argument serialization corruption/i);
    assert.match(boolRes.text, /edits\[0\]: received boolean \(false\)/);
    assert.match(boolRes.text, /edits\[1\]: received boolean \(true\)/);
    assert.match(boolRes.text, /Do NOT retry the same apply_edits payload/);
    assert.match(boolRes.text, /edit_file/);

    const nullRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [null, null] as unknown as never[],
    });
    assert.equal(nullRes.isError, true);
    assert.match(nullRes.text, /edits\[0\]: received null/);

    // Nested hunks collapsed to boolean/null
    const hunkRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "corrupt-test.ts", hunks: [true] }] as unknown as never[],
    });
    assert.equal(hunkRes.isError, true);
    assert.match(hunkRes.text, /edits\[0\]\.hunks\[0\]: received boolean \(true\)/);

    const hunksBoolRes = await runApplyEdits({
      cwd: tmpDir,
      edits: [{ path: "corrupt-test.ts", hunks: true }] as unknown as never[],
    });
    assert.equal(hunksBoolRes.isError, true);
    assert.match(hunksBoolRes.text, /edits\[0\]\.hunks: received boolean \(true\)/);

    // Top-level edits collapsed to boolean
    const topBool = await runApplyEdits({
      cwd: tmpDir,
      edits: true as unknown as never[],
    });
    assert.equal(topBool.isError, true);
    assert.match(topBool.text, /edits: received boolean \(true\)/);

    // Verify file remained untouched
    assert.equal(await fs.readFile(file, "utf8"), "export const x = 1;\n");

    // Stringified JSON array tolerance works cleanly
    const stringifiedRes = await runApplyEdits({
      cwd: tmpDir,
      edits: JSON.stringify([
        {
          path: "corrupt-test.ts",
          hunks: [{ target: "export const x = 1;", replacement: "export const x = 42;" }],
        },
      ]) as unknown as never[],
    });
    assert.equal(stringifiedRes.isError, false);
    assert.equal(await fs.readFile(file, "utf8"), "export const x = 42;\n");
  });

  function makeErrnoError(code: string, message: string): NodeJS.ErrnoException {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  }

  it("does not fall back to direct write or leave tmp files when temp write fails in Phase 2", async () => {
    const subDir = path.join(tmpDir, "phase2-tmp-fail");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const firstFile = path.join(realSubDir, "first.txt");
    const targetFile = path.join(realSubDir, "target.txt");
    await fs.writeFile(firstFile, "first orig\n", "utf8");
    await fs.writeFile(targetFile, "target orig\n", "utf8");

    const origWriteFile = fs.writeFile;
    let directWriteAttempted = false;
    fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
      const p = String(args[0]);
      if (p.startsWith(`${targetFile}.agy-fast-tmp-`)) {
        await origWriteFile(p, "partial");
        throw makeErrnoError("ENOSPC", "ENOSPC: no space left on device");
      }
      if (p === targetFile) {
        directWriteAttempted = true;
        await origWriteFile(p, "");
        throw makeErrnoError("ENOSPC", "ENOSPC: no space left on device");
      }
      return origWriteFile(...args);
    }) as typeof fs.writeFile;

    try {
      const res = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "first.txt", hunks: [{ target: "first orig", replacement: "first mod" }] },
          { path: "target.txt", hunks: [{ target: "target orig", replacement: "target mod" }] },
        ],
      });
      assert.equal(res.isError, true);
      assert.match(res.text, /Write failed \(changes rolled back\)/);
      assert.match(res.text, /ENOSPC/);
      assert.equal(directWriteAttempted, false);
    } finally {
      fs.writeFile = origWriteFile;
    }

    assert.equal(await fs.readFile(firstFile, "utf8"), "first orig\n");
    assert.equal(await fs.readFile(targetFile, "utf8"), "target orig\n");
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.includes(".agy-fast-tmp-")), false);
  });

  it("rolls back target file and removes partial created file when rename and fallback direct write both fail", async () => {
    const subDir = path.join(tmpDir, "phase2-fallback-fail");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const firstFile = path.join(realSubDir, "first.txt");
    const targetFile = path.join(realSubDir, "target.txt");
    const newFile = path.join(realSubDir, "created-fail.txt");
    await fs.writeFile(firstFile, "first orig\n", "utf8");
    await fs.writeFile(targetFile, "target orig\n", "utf8");

    const origRename = fs.rename;
    const origWriteFile = fs.writeFile;
    let targetWriteCalls = 0;

    fs.rename = (async (...args: Parameters<typeof origRename>) => {
      if (String(args[1]) === targetFile || String(args[1]) === newFile) {
        throw makeErrnoError("EXDEV", "EXDEV: cross-device link not permitted");
      }
      return origRename(...args);
    }) as typeof fs.rename;

    fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
      const p = String(args[0]);
      if (p === targetFile && ++targetWriteCalls === 1) {
        await origWriteFile(p, "");
        throw makeErrnoError("EIO", "EIO: i/o error");
      }
      if (p === newFile) {
        await origWriteFile(p, "");
        throw makeErrnoError("EIO", "EIO: i/o error");
      }
      return origWriteFile(...args);
    }) as typeof fs.writeFile;

    try {
      const existingRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "first.txt", hunks: [{ target: "first orig", replacement: "first mod" }] },
          { path: "target.txt", hunks: [{ target: "target orig", replacement: "target mod" }] },
        ],
      });
      assert.equal(existingRes.isError, true);
      assert.match(existingRes.text, /Write failed \(changes rolled back\)/);
      assert.match(existingRes.text, /EIO/);
      assert.equal(targetWriteCalls, 2);

      const createdRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "created-fail.txt", create: "new content\n" }],
      });
      assert.equal(createdRes.isError, true);
      assert.match(createdRes.text, /Write failed \(changes rolled back\)/);
      assert.match(createdRes.text, /EIO/);
    } finally {
      fs.rename = origRename;
      fs.writeFile = origWriteFile;
    }

    assert.equal(await fs.readFile(firstFile, "utf8"), "first orig\n");
    assert.equal(await fs.readFile(targetFile, "utf8"), "target orig\n");
    await assert.rejects(() => fs.stat(newFile), { code: "ENOENT" });
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.includes(".agy-fast-tmp-")), false);
  });

  it("fails fast on non-ENOENT errors in create without overwriting or deleting existing files", async () => {
    const subDir = path.join(tmpDir, "create-non-enoent");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);
    const statErrFile = path.join(realSubDir, "stat-err.txt");
    const busyFile = path.join(realSubDir, "busy.txt");
    const otherFile = path.join(realSubDir, "other.txt");
    await fs.writeFile(statErrFile, "keep stat-err\n", "utf8");
    await fs.writeFile(busyFile, "precious original\n", "utf8");
    await fs.writeFile(otherFile, "other orig\n", "utf8");

    const origStat = fs.stat;
    fs.stat = (async (...args: Parameters<typeof origStat>) => {
      if (String(args[0]) === statErrFile) {
        throw makeErrnoError("EACCES", `EACCES: permission denied, stat '${statErrFile}'`);
      }
      return origStat(...args);
    }) as typeof fs.stat;

    try {
      const statRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "stat-err.txt", create: "clobbered\n" }],
      });
      assert.equal(statRes.isError, true);
      assert.match(statRes.text, /0 files modified/);
      assert.match(statRes.text, /EACCES/);
    } finally {
      fs.stat = origStat;
    }
    assert.equal(await fs.readFile(statErrFile, "utf8"), "keep stat-err\n");

    const origReadFile = fs.readFile;
    fs.readFile = (async (...args: Parameters<typeof origReadFile>) => {
      if (String(args[0]) === busyFile) {
        throw makeErrnoError("EBUSY", `EBUSY: resource busy or locked, open '${busyFile}'`);
      }
      return origReadFile(...args);
    }) as typeof fs.readFile;

    try {
      const atomicRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [
          { path: "busy.txt", create: "replaced\n", overwrite: true },
          { path: "other.txt", hunks: [{ target: "other orig", replacement: "other mod" }] },
        ],
      });
      assert.equal(atomicRes.isError, true);
      assert.match(atomicRes.text, /0 files modified/);
      assert.match(atomicRes.text, /EBUSY/);

      const partialRes = await runApplyEdits({
        cwd: realSubDir,
        bestEffort: true,
        edits: [
          { path: "busy.txt", create: "replaced\n", overwrite: true },
          { path: "other.txt", hunks: [{ target: "other orig", replacement: "other mod" }] },
        ],
      });
      assert.equal(partialRes.isError, true);
      assert.match(partialRes.text, /Partial edit applied \(1\/2 file\(s\) written; 1 file\(s\) failed/);
      assert.match(partialRes.text, /EBUSY/);
    } finally {
      fs.readFile = origReadFile;
    }

    assert.equal(await fs.readFile(busyFile, "utf8"), "precious original\n");
    assert.equal(await fs.readFile(otherFile, "utf8"), "other mod\n");
  });

  it("protects dangling symlinks on create, preserves majority LF EOL, validates verify before writes, and avoids lone surrogates", async () => {
    const subDir = path.join(tmpDir, "hardening-edge");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);

    // 1. Dangling symlink protection (overwrite: false refuses; overwrite: true restores symlink on Phase-2 rollback)
    const danglingLink = path.join(realSubDir, "dangling.txt");
    let createdFileSymlink = false;
    try {
      await fs.symlink("missing-target.txt", danglingLink);
      createdFileSymlink = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "ENOTSUP")) {
        throw err;
      }
    }
    if (createdFileSymlink) {
      const blockedSym = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "dangling.txt", create: "clobbered\n", overwrite: false }],
      });
      assert.equal(blockedSym.isError, true);
      assert.match(blockedSym.text, /dangling symlink/);
      assert.equal((await fs.lstat(danglingLink)).isSymbolicLink(), true);

      const failTarget = path.join(realSubDir, "fail-after.txt");
      await fs.writeFile(failTarget, "orig\n", "utf8");
      const origRename = fs.rename;
      const origWriteFile = fs.writeFile;
      fs.rename = (async (...args: Parameters<typeof origRename>) => {
        if (String(args[1]) === failTarget) throw makeErrnoError("EXDEV", "EXDEV");
        return origRename(...args);
      }) as typeof fs.rename;
      fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
        if (String(args[0]) === failTarget) throw makeErrnoError("EIO", "EIO");
        return origWriteFile(...args);
      }) as typeof fs.writeFile;
      try {
        const rbSym = await runApplyEdits({
          cwd: realSubDir,
          edits: [
            { path: "dangling.txt", create: "replaced\n", overwrite: true },
            { path: "fail-after.txt", hunks: [{ target: "orig", replacement: "mod" }] },
          ],
        });
        assert.equal(rbSym.isError, true);
        assert.match(rbSym.text, /rolled back/);
      } finally {
        fs.rename = origRename;
        fs.writeFile = origWriteFile;
      }
      assert.equal((await fs.lstat(danglingLink)).isSymbolicLink(), true);
      assert.equal(await fs.readlink(danglingLink), "missing-target.txt");
    }

    // 2. Symlinked parent directory deduplication for new files
    const realChildDir = path.join(realSubDir, "real-dir");
    const symChildDir = path.join(realSubDir, "sym-dir");
    await fs.mkdir(realChildDir, { recursive: true });
    await fs.symlink(realChildDir, symChildDir, process.platform === "win32" ? "junction" : "dir");
    const dupCreate = await runApplyEdits({
      cwd: realSubDir,
      edits: [
        { path: "real-dir/new.ts", create: "a\n" },
        { path: "sym-dir/new.ts", create: "b\n" },
      ],
    });
    assert.equal(dupCreate.isError, true);
    assert.match(dupCreate.text, /duplicate entries cannot mix 'create'/);

    // 3. Single CRLF in an LF-majority script must NOT rewrite the whole file to CRLF
    const scriptPath = path.join(realSubDir, "run.sh");
    await fs.writeFile(scriptPath, "#!/usr/bin/env bash\necho 1\r\necho 2\necho 3\n", "utf8");
    const lfRes = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "run.sh", hunks: [{ target: "echo 3", replacement: "echo 4" }] }],
    });
    assert.equal(lfRes.isError, false);
    const scriptAfter = await fs.readFile(scriptPath, "utf8");
    assert.ok(scriptAfter.startsWith("#!/usr/bin/env bash\n"));
    assert.ok(!scriptAfter.includes("\r\n"));

    // 4. Malformed verify fails validation BEFORE writing files; non-finite verifyTimeoutSec/maxVerifyChars stay safe
    const verifyFile = path.join(realSubDir, "v.ts");
    await fs.writeFile(verifyFile, "export const v = 1;\n", "utf8");
    const badVerify = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "v.ts", hunks: [{ target: "v = 1", replacement: "v = 2" }] }],
      verify: { command: true as unknown as string },
    });
    assert.equal(badVerify.isError, true);
    assert.match(badVerify.text, /0 files modified/);
    assert.equal(await fs.readFile(verifyFile, "utf8"), "export const v = 1;\n");

    const nanVerify = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "v.ts", hunks: [{ target: "v = 1", replacement: "v = 2" }] }],
      verify: `${JSON.stringify(process.execPath)} -e "console.log('verify ok')"`,
      verifyTimeoutSec: Number.NaN,
      maxVerifyChars: Number.NaN,
    });
    assert.equal(nanVerify.isError, false);
    assert.match(nanVerify.text, /Verify \[PASS/);
    assert.match(nanVerify.text, /verify ok/);

    // 5. Long emoji line in mismatch snippet does not emit a lone surrogate
    const emojiFile = path.join(realSubDir, "emoji.ts");
    await fs.writeFile(emojiFile, `const token = "${"x".repeat(142)}${"🚀".repeat(30)}";\n`, "utf8");
    const emojiMiss = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "emoji.ts", hunks: [{ startLine: 1, endLine: 1, target: "nonexistent", replacement: "y" }] }],
    });
    assert.equal(emojiMiss.isError, true);
    assert.equal(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiMiss.text),
      false,
    );
  });

  it("deletes files via zero-copy staging, prunes empty parent dirs, and honors dryRun", async () => {
    const subDir = path.join(tmpDir, "delete-prune");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);

    const deepFile = path.join(realSubDir, "deep", "nested", "leaf", "only.bin");
    const partialFile = path.join(realSubDir, "partial", "sub", "last.txt");
    const partialKeep = path.join(realSubDir, "partial", "keep.txt");
    const overrideFile = path.join(realSubDir, "keep-empty", "gone.txt");
    const sameDirOld = path.join(realSubDir, "same-dir", "old.txt");

    await fs.mkdir(path.dirname(deepFile), { recursive: true });
    await fs.mkdir(path.dirname(partialFile), { recursive: true });
    await fs.mkdir(path.dirname(overrideFile), { recursive: true });
    await fs.mkdir(path.dirname(sameDirOld), { recursive: true });

    await fs.writeFile(deepFile, Buffer.from([0x00, 0x01, 0xff, 0x42]));
    await fs.writeFile(partialFile, "bye\n", "utf8");
    await fs.writeFile(partialKeep, "stay\n", "utf8");
    await fs.writeFile(overrideFile, "gone\n", "utf8");
    await fs.writeFile(sameDirOld, "old\n", "utf8");

    // Dry-run previews pruned dirs accurately without modifying disk
    const dryRes = await runApplyEdits({
      cwd: realSubDir,
      dryRun: true,
      pruneEmptyDirs: true,
      edits: [
        { path: "deep/nested/leaf/only.bin", delete: true },
        { path: "partial/sub/last.txt", delete: true },
        { path: "keep-empty/gone.txt", delete: true, pruneEmptyDirs: false },
        { path: "same-dir/old.txt", delete: true },
        { path: "same-dir/new.txt", create: "fresh\n" },
      ],
    });
    assert.equal(dryRes.isError, false);
    assert.match(dryRes.text, /Dry run validated 5 file\(s\)/);
    const prunedLine = dryRes.text
      .split("\n")
      .find((line) => line.startsWith("Would prune empty dir(s):")) ?? "";
    assert.match(prunedLine, /deep\/nested\/leaf/);
    assert.match(prunedLine, /deep\/nested/);
    assert.match(prunedLine, /\bdeep\b/);
    assert.match(prunedLine, /partial\/sub/);
    assert.doesNotMatch(prunedLine, /keep-empty/);
    assert.doesNotMatch(prunedLine, /same-dir/);
    // Nothing touched on disk during dryRun
    await fs.stat(deepFile);
    await fs.stat(partialFile);

    // Real run: verify fs.readFile is NOT called for deleted binary files (zero-copy staging)
    const origReadFile = fs.readFile;
    let readDeepFile = false;
    fs.readFile = (async (...args: Parameters<typeof origReadFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(deepFile)) {
        readDeepFile = true;
      }
      return origReadFile(...args);
    }) as typeof fs.readFile;

    let res;
    try {
      res = await runApplyEdits({
        cwd: realSubDir,
        pruneEmptyDirs: true,
        edits: [
          { path: "deep/nested/leaf/only.bin", delete: true },
          { path: "partial/sub/last.txt", delete: true },
          { path: "keep-empty/gone.txt", delete: true, pruneEmptyDirs: false },
          { path: "same-dir/old.txt", delete: true },
          { path: "same-dir/new.txt", create: "fresh\n" },
        ],
      });
    } finally {
      fs.readFile = origReadFile;
    }

    assert.equal(res.isError, false);
    assert.equal(readDeepFile, false);
    assert.match(res.text, /Pruned empty dir\(s\):/);

    // Cascading empty dirs pruned; cwd itself preserved
    await assert.rejects(() => fs.stat(path.join(realSubDir, "deep")), { code: "ENOENT" });
    await fs.stat(realSubDir);
    // Partial empty subdir pruned; non-empty parent preserved
    await assert.rejects(() => fs.stat(path.join(realSubDir, "partial", "sub")), { code: "ENOENT" });
    await fs.stat(partialKeep);
    // Per-entry pruneEmptyDirs: false override kept empty parent dir
    assert.deepEqual(await fs.readdir(path.join(realSubDir, "keep-empty")), []);
    // Same-dir delete + create preserved directory and created new file
    assert.equal(await fs.readFile(path.join(realSubDir, "same-dir", "new.txt"), "utf8"), "fresh\n");
    await assert.rejects(() => fs.stat(sameDirOld), { code: "ENOENT" });
    // No transaction staging dir left behind
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.startsWith(".agy-fast-tx-")), false);
  });

  it("enforces cwd scope boundary, .git protection, and validation guards for delete and moveTo", async () => {
    const outerDir = path.join(tmpDir, "scope-outer");
    const workDir = path.join(outerDir, "workspace");
    await fs.mkdir(path.join(workDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(workDir, "subdir"), { recursive: true });
    const realWorkDir = await fs.realpath(workDir);

    const outsideFile = path.join(outerDir, "outside.txt");
    const gitConfig = path.join(realWorkDir, ".git", "config");
    const insideFile = path.join(realWorkDir, "inside.txt");
    await fs.writeFile(outsideFile, "do not touch\n", "utf8");
    await fs.writeFile(gitConfig, "[core]\n", "utf8");
    await fs.writeFile(insideFile, "hello\n", "utf8");

    // 1. Delete outside cwd (relative .. and absolute) blocked
    const escapeRel = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "../outside.txt", delete: true }],
    });
    assert.equal(escapeRel.isError, true);
    assert.match(escapeRel.text, /strictly inside cwd/);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "do not touch\n");

    const escapeAbs = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: outsideFile, delete: true }],
    });
    assert.equal(escapeAbs.isError, true);
    assert.match(escapeAbs.text, /strictly inside cwd/);

    // 2. Delete or move inside .git blocked
    const gitDel = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: ".git/config", delete: true }],
    });
    assert.equal(gitDel.isError, true);
    assert.match(gitDel.text, /\.git/);
    assert.equal(await fs.readFile(gitConfig, "utf8"), "[core]\n");

    const gitMove = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "inside.txt", moveTo: ".git/hijack" }],
    });
    assert.equal(gitMove.isError, true);
    assert.match(gitMove.text, /\.git/);

    // 3. Move destination escaping cwd blocked
    const moveEscape = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "inside.txt", moveTo: "../escaped.txt" }],
    });
    assert.equal(moveEscape.isError, true);
    assert.match(moveEscape.text, /strictly inside cwd/);
    assert.equal(await fs.readFile(insideFile, "utf8"), "hello\n");

    // 4. Direct directory delete & move blocked
    const dirDel = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "subdir", delete: true }],
    });
    assert.equal(dirDel.isError, true);
    assert.match(dirDel.text, /directory/);

    const dirMove = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "subdir", moveTo: "subdir2" }],
    });
    assert.equal(dirMove.isError, true);
    assert.match(dirMove.text, /directory/);

    // 5. Mutually exclusive fields & same-path move rejected
    const badCombo = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "inside.txt", delete: true, moveTo: "other.txt" }],
    });
    assert.equal(badCombo.isError, true);
    assert.match(badCombo.text, /cannot combine 'delete'/);

    const sameMove = await runApplyEdits({
      cwd: realWorkDir,
      edits: [{ path: "inside.txt", moveTo: "./inside.txt" }],
    });
    assert.equal(sameMove.isError, true);
    assert.match(sameMove.text, /same path/);

    // 6. Symlink boundary checks (when OS permits creating symlinks)
    let canSymlink = true;
    const probeLink = path.join(realWorkDir, "probe-link.txt");
    try {
      await fs.symlink(outsideFile, probeLink);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "EPERM") {
        canSymlink = false;
      } else {
        throw err;
      }
    }
    if (canSymlink) {
      // Deleting symlink inside cwd removes only the symlink, leaving outside target untouched
      const delLink = await runApplyEdits({
        cwd: realWorkDir,
        edits: [{ path: "probe-link.txt", delete: true }],
      });
      assert.equal(delLink.isError, false);
      await assert.rejects(() => fs.lstat(probeLink), { code: "ENOENT" });
      assert.equal(await fs.readFile(outsideFile, "utf8"), "do not touch\n");

      // Deleting through a symlinked parent directory escaping cwd must be blocked
      const escapeDirLink = path.join(realWorkDir, "escape-dir");
      await fs.symlink(outerDir, escapeDirLink, "dir");
      const escapeViaParent = await runApplyEdits({
        cwd: realWorkDir,
        edits: [{ path: "escape-dir/outside.txt", delete: true }],
      });
      assert.equal(escapeViaParent.isError, true);
      assert.match(escapeViaParent.text, /strictly inside cwd/);
      assert.equal(await fs.readFile(outsideFile, "utf8"), "do not touch\n");
    }
  });

  it("supports moveTo (pure move, moveTo + hunks, overwrite, atomic swap, vacated paths, and case-only rename)", async () => {
    const subDir = path.join(tmpDir, "move-features");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);

    // 1. Pure move of binary file + pruneEmptyDirs
    const binSrc = path.join(realSubDir, "old-assets", "logo.bin");
    const binPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a]);
    await fs.mkdir(path.dirname(binSrc), { recursive: true });
    await fs.writeFile(binSrc, binPayload);

    // 2. moveTo + hunks (preserving CRLF) + pruneEmptyDirs
    const codeSrc = path.join(realSubDir, "legacy", "helper.ts");
    await fs.mkdir(path.dirname(codeSrc), { recursive: true });
    await fs.writeFile(codeSrc, "import { x } from './x';\r\nexport const v = x;\r\n", "utf8");

    // 3. Atomic swap a <-> b
    await fs.writeFile(path.join(realSubDir, "a.txt"), "content-A\n", "utf8");
    await fs.writeFile(path.join(realSubDir, "b.txt"), "content-B\n", "utf8");

    // 4. Move into deleted path + create at vacated move source
    await fs.writeFile(path.join(realSubDir, "drop-me.txt"), "old-drop\n", "utf8");
    await fs.writeFile(path.join(realSubDir, "shift-me.txt"), "shifted-body\n", "utf8");

    const res = await runApplyEdits({
      cwd: realSubDir,
      pruneEmptyDirs: true,
      edits: [
        { path: "old-assets/logo.bin", moveTo: "assets/new-logo.bin" },
        {
          path: "legacy/helper.ts",
          moveTo: "src/utils/helper.ts",
          hunks: [{ target: "./x", replacement: "../../x" }],
        },
        { path: "a.txt", moveTo: "b.txt" },
        { path: "b.txt", moveTo: "a.txt" },
        { path: "drop-me.txt", delete: true },
        { path: "shift-me.txt", moveTo: "drop-me.txt" },
        { path: "shift-me.txt", create: "brand-new-stub\n" },
      ],
    });
    assert.equal(res.isError, false);
    assert.match(res.text, /old-assets\/logo\.bin -> assets\/new-logo\.bin: moved/);
    assert.match(res.text, /legacy\/helper\.ts -> src\/utils\/helper\.ts: moved & updated/);
    assert.match(res.text, /Pruned empty dir\(s\):/);

    assert.deepEqual(
      await fs.readFile(path.join(realSubDir, "assets", "new-logo.bin")),
      binPayload,
    );
    await assert.rejects(() => fs.stat(path.join(realSubDir, "old-assets")), { code: "ENOENT" });

    assert.equal(
      await fs.readFile(path.join(realSubDir, "src", "utils", "helper.ts"), "utf8"),
      "import { x } from '../../x';\r\nexport const v = x;\r\n",
    );
    await assert.rejects(() => fs.stat(path.join(realSubDir, "legacy")), { code: "ENOENT" });

    assert.equal(await fs.readFile(path.join(realSubDir, "a.txt"), "utf8"), "content-B\n");
    assert.equal(await fs.readFile(path.join(realSubDir, "b.txt"), "utf8"), "content-A\n");
    assert.equal(await fs.readFile(path.join(realSubDir, "drop-me.txt"), "utf8"), "shifted-body\n");
    assert.equal(await fs.readFile(path.join(realSubDir, "shift-me.txt"), "utf8"), "brand-new-stub\n");

    // 5. Overwrite guard on moveTo
    const blockedOverwrite = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "a.txt", moveTo: "b.txt" }],
    });
    assert.equal(blockedOverwrite.isError, true);
    assert.match(blockedOverwrite.text, /already exists/);

    const allowedOverwrite = await runApplyEdits({
      cwd: realSubDir,
      edits: [{ path: "a.txt", moveTo: "b.txt", overwrite: true }],
    });
    assert.equal(allowedOverwrite.isError, false);
    await assert.rejects(() => fs.stat(path.join(realSubDir, "a.txt")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(realSubDir, "b.txt"), "utf8"), "content-B\n");

    // 6. Case-only rename on case-insensitive filesystems (Windows / macOS)
    if (process.platform === "win32" || process.platform === "darwin") {
      await fs.writeFile(path.join(realSubDir, "camelFile.txt"), "case-test\n", "utf8");
      const caseRes = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "camelFile.txt", moveTo: "CamelFile.txt" }],
      });
      assert.equal(caseRes.isError, false);
      const entries = await fs.readdir(realSubDir);
      assert.equal(entries.includes("CamelFile.txt"), true);
      assert.equal(await fs.readFile(path.join(realSubDir, "CamelFile.txt"), "utf8"), "case-test\n");
    }
  });

  it("rolls back deleted files, moved files, overwritten targets, and pruned empty dirs on Phase 2 failure", async () => {
    const subDir = path.join(tmpDir, "delete-move-rollback");
    await fs.mkdir(subDir, { recursive: true });
    const realSubDir = await fs.realpath(subDir);

    // Scenario A: Failure during Stage 2b write rolls back Stage 1 deletes, moves, and overwrites
    const delFile = path.join(realSubDir, "del-dir", "big.bin");
    const mvSrc = path.join(realSubDir, "mv-dir", "src.bin");
    const mvDest = path.join(realSubDir, "existing.bin");
    const failTarget = path.join(realSubDir, "fail.txt");
    await fs.mkdir(path.dirname(delFile), { recursive: true });
    await fs.mkdir(path.dirname(mvSrc), { recursive: true });

    const delBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const mvSrcBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x02]);
    const mvDestBytes = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x00, 0x03]);
    await fs.writeFile(delFile, delBytes);
    await fs.writeFile(mvSrc, mvSrcBytes);
    await fs.writeFile(mvDest, mvDestBytes);
    await fs.writeFile(failTarget, "original fail\n", "utf8");

    const origWriteFile = fs.writeFile;
    fs.writeFile = (async (...args: Parameters<typeof origWriteFile>) => {
      if (String(args[0]).startsWith(`${failTarget}.agy-fast-tmp-`)) {
        throw makeErrnoError("ENOSPC", "ENOSPC: disk full");
      }
      return origWriteFile(...args);
    }) as typeof fs.writeFile;

    try {
      const resA = await runApplyEdits({
        cwd: realSubDir,
        pruneEmptyDirs: true,
        edits: [
          { path: "del-dir/big.bin", delete: true },
          { path: "mv-dir/src.bin", moveTo: "existing.bin", overwrite: true },
          { path: "fail.txt", hunks: [{ target: "original fail", replacement: "updated fail" }] },
        ],
      });
      assert.equal(resA.isError, true);
      assert.match(resA.text, /Write failed \(changes rolled back\)/);
      assert.match(resA.text, /ENOSPC/);
    } finally {
      fs.writeFile = origWriteFile;
    }

    assert.deepEqual(await fs.readFile(delFile), delBytes);
    assert.deepEqual(await fs.readFile(mvSrc), mvSrcBytes);
    assert.deepEqual(await fs.readFile(mvDest), mvDestBytes);
    assert.equal(await fs.readFile(failTarget, "utf8"), "original fail\n");
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.startsWith(".agy-fast-tx-")), false);

    // Scenario B: Stage 3 rmdir failure rolls back already-pruned subdir and restores deleted file
    const p1p2 = path.join(realSubDir, "p1", "p2");
    const p3Leaf = path.join(p1p2, "p3", "leaf.txt");
    await fs.mkdir(path.dirname(p3Leaf), { recursive: true });
    await fs.writeFile(p3Leaf, "survive rollback\n", "utf8");

    const origRmdir = fs.rmdir;
    fs.rmdir = (async (...args: Parameters<typeof origRmdir>) => {
      if (path.resolve(String(args[0])) === path.resolve(p1p2)) {
        throw makeErrnoError("EACCES", "EACCES: permission denied");
      }
      return origRmdir(...args);
    }) as typeof fs.rmdir;

    try {
      const resB = await runApplyEdits({
        cwd: realSubDir,
        edits: [{ path: "p1/p2/p3/leaf.txt", delete: true, pruneEmptyDirs: true }],
      });
      assert.equal(resB.isError, true);
      assert.match(resB.text, /Write failed \(changes rolled back\)/);
      assert.match(resB.text, /EACCES/);
    } finally {
      fs.rmdir = origRmdir;
    }

    assert.equal(await fs.readFile(p3Leaf, "utf8"), "survive rollback\n");
    assert.equal((await fs.readdir(realSubDir)).some((n) => n.startsWith(".agy-fast-tx-")), false);

    // Scenario C: bestEffort applies valid delete/move and reports failed entries without touching invalid targets
    const beRes = await runApplyEdits({
      cwd: realSubDir,
      bestEffort: true,
      edits: [
        { path: "p1/p2/p3/leaf.txt", delete: true, pruneEmptyDirs: true },
        { path: "does-not-exist.txt", delete: true },
        { path: "fail.txt", moveTo: "existing.bin" }, // blocked by overwrite: false
      ],
    });
    assert.equal(beRes.isError, true);
    assert.match(beRes.text, /Partial edit applied \(1\/3/);
    assert.match(beRes.text, /Pruned empty dir\(s\):/);
    await assert.rejects(() => fs.stat(path.join(realSubDir, "p1")), { code: "ENOENT" });
    assert.equal(await fs.readFile(failTarget, "utf8"), "original fail\n");
  });
});
