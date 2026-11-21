// agy-fast MCP Stdio Server (bundled zero-dependency ESM)


// src/protocol/mcp.ts
var SUPPORTED_PROTOCOL_VERSIONS = /* @__PURE__ */ new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
var DEFAULT_PROTOCOL_VERSION = "2025-03-26";
var McpStdioServer = class {
  tools = /* @__PURE__ */ new Map();
  serverName;
  serverVersion;
  inFlight = 0;
  stdinEnded = false;
  onDrainExit;
  constructor(options) {
    this.serverName = options.name;
    this.serverVersion = options.version;
  }
  registerTool(definition, handler) {
    this.tools.set(definition.name, { definition, handler });
  }
  async handleMessage(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" }
      };
    }
    const msg = raw;
    const hasId = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== void 0;
    const id = hasId ? msg.id ?? null : null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }
    if (!hasId) {
      return null;
    }
    if (method === "initialize") {
      const requested = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion.trim() : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion
          }
        }
      };
    }
    if (method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (method === "tools/list") {
      const definitions = [...this.tools.values()].map((t) => t.definition);
      return { jsonrpc: "2.0", id, result: { tools: definitions } };
    }
    if (method === "resources/list") {
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    }
    if (method === "resources/templates/list") {
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    }
    if (method === "prompts/list") {
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    }
    if (method === "tools/call") {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const tool = this.tools.get(name);
      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${name}` }
        };
      }
      const rawArgs = msg.params?.arguments;
      let args;
      if (rawArgs === void 0 || rawArgs === null) {
        args = {};
      } else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
        args = rawArgs;
      } else if (typeof rawArgs === "string" && rawArgs.trim().startsWith("{")) {
        try {
          const parsedArgs = JSON.parse(rawArgs);
          if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
            args = parsedArgs;
          } else {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Invalid params: 'arguments' for '${name}' must be a JSON object`
              }
            };
          }
        } catch {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: `Invalid params: malformed JSON string in 'arguments' for '${name}'`
            }
          };
        }
      } else {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Invalid params: 'arguments' for '${name}' must be an object (received ${Array.isArray(rawArgs) ? "array" : typeof rawArgs})`
          }
        };
      }
      try {
        const res = await tool.handler(args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: res.text }],
            isError: Boolean(res.isError)
          }
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Tool error: ${message}` }],
            isError: true
          }
        };
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }
  listen(input = process.stdin, output = process.stdout, onExit) {
    this.onDrainExit = onExit;
    let buffer = Buffer.alloc(0);
    const writeResponse = (payload, useContentLength) => {
      const serialized = JSON.stringify(payload);
      if (useContentLength) {
        const len = Buffer.byteLength(serialized, "utf8");
        output.write(`Content-Length: ${len}\r
\r
${serialized}`);
      } else {
        output.write(`${serialized}
`);
      }
    };
    const dispatchRawJson = (jsonText, useContentLength) => {
      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        writeResponse(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" }
          },
          useContentLength
        );
        return;
      }
      this.inFlight += 1;
      const finish = () => {
        this.inFlight -= 1;
        if (this.stdinEnded && this.inFlight === 0) {
          this.onDrainExit?.();
        }
      };
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          writeResponse(
            {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32600, message: "Invalid Request: empty batch" }
            },
            useContentLength
          );
          finish();
          return;
        }
        Promise.all(parsed.map((item) => this.handleMessage(item))).then((responses) => {
          const nonNull = responses.filter(
            (r) => r !== null
          );
          if (nonNull.length > 0) {
            writeResponse(nonNull, useContentLength);
          }
        }).finally(finish);
        return;
      }
      this.handleMessage(parsed).then((response) => {
        if (response !== null) {
          writeResponse(response, useContentLength);
        }
      }).finally(finish);
    };
    const drainBuffer = () => {
      while (buffer.length > 0) {
        let offset = 0;
        while (offset < buffer.length && (buffer[offset] === 10 || buffer[offset] === 13)) {
          offset++;
        }
        if (offset > 0) {
          buffer = buffer.subarray(offset);
          if (buffer.length === 0) break;
        }
        const headerProbe = buffer.subarray(0, 16).toString("latin1").toLowerCase();
        if (headerProbe.startsWith("content-length:") || headerProbe.startsWith("content-type:")) {
          const crlfEnd = buffer.indexOf("\r\n\r\n");
          const lfEnd = buffer.indexOf("\n\n");
          let sepIdx = -1;
          let sepLen = 0;
          if (crlfEnd !== -1 && (lfEnd === -1 || crlfEnd < lfEnd)) {
            sepIdx = crlfEnd;
            sepLen = 4;
          } else if (lfEnd !== -1) {
            sepIdx = lfEnd;
            sepLen = 2;
          }
          if (sepIdx === -1) break;
          const headerText = buffer.subarray(0, sepIdx).toString("latin1");
          const clMatches = [...headerText.matchAll(/^content-length:[ \t]*(\d+)[ \t]*\r?$/gim)];
          const maxFrameBytes = 64 * 1024 * 1024;
          if (clMatches.length !== 1) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: invalid Content-Length header" }
              },
              true
            );
            buffer = buffer.subarray(sepIdx + sepLen);
            continue;
          }
          const contentLength = Number(clMatches[0][1]);
          if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxFrameBytes) {
            writeResponse(
              {
                jsonrpc: "2.0",
                id: null,
                error: { code: -32600, message: "Invalid Request: Content-Length out of bounds" }
              },
              true
            );
            buffer = Buffer.alloc(0);
            break;
          }
          const bodyStart = sepIdx + sepLen;
          if (buffer.length < bodyStart + contentLength) {
            break;
          }
          const bodyText = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.subarray(bodyStart + contentLength);
          dispatchRawJson(bodyText, true);
          continue;
        }
        const newlineIdx = buffer.indexOf(10);
        if (newlineIdx === -1) break;
        const lineBuf = buffer.subarray(0, newlineIdx);
        buffer = buffer.subarray(newlineIdx + 1);
        const line = lineBuf.toString("utf8").trim();
        if (line.length > 0) {
          dispatchRawJson(line, false);
        }
      }
    };
    input.on("data", (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
      drainBuffer();
    });
    input.on("end", () => {
      const remaining = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      const lowerRem = remaining.toLowerCase();
      if (remaining.length > 0 && !lowerRem.startsWith("content-length:") && !lowerRem.startsWith("content-type:")) {
        dispatchRawJson(remaining, false);
      }
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
    input.on("error", () => {
      this.stdinEnded = true;
      if (this.inFlight === 0) {
        this.onDrainExit?.();
      }
    });
  }
};

// src/tools/apply-edits.ts
import { promises as fs2 } from "node:fs";
import path3 from "node:path";

// src/utils/arg-validation.ts
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function describeValueType(value) {
  if (value === null) return "null";
  if (value === void 0) return "undefined";
  if (Array.isArray(value)) return `array (len=${value.length})`;
  if (typeof value === "boolean") return `boolean (${String(value)})`;
  if (typeof value === "number") return `number (${String(value)})`;
  if (typeof value === "string") return `string (len=${value.length})`;
  return typeof value;
}
function parseMaybeJsonArray(value) {
  if (value === void 0) {
    return { ok: false, kind: "missing", detail: "undefined" };
  }
  if (Array.isArray(value)) {
    return { ok: true, value };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return { ok: true, value: parsed };
        }
      } catch (err) {
        return {
          ok: false,
          kind: "invalid_json",
          detail: err instanceof Error ? err.message : String(err)
        };
      }
    }
  }
  return {
    ok: false,
    kind: "wrong_type",
    detail: describeValueType(value)
  };
}
function formatCorruptedArrayError(options) {
  const details = options.items.slice(0, 8).map(
    (item) => `- ${item.label}: received ${describeValueType(item.value)} instead of ${item.expected ?? "an object"}`
  );
  if (options.items.length > 8) {
    details.push(`- ... (+${options.items.length - 8} more corrupted entries)`);
  }
  return [
    `${options.header}: nested argument serialization corruption detected in call_mcp_tool.`,
    ...details,
    "",
    `Hint: untyped call_mcp_tool Arguments can occasionally collapse nested objects/arrays into booleans or null. Do NOT retry the same ${options.toolName} payload \u2014 ${options.fallbackAdvice}`
  ].join("\n");
}

// src/utils/exec-utils.ts
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
var DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
var WINDOWS_CODEPAGE_LABELS = {
  866: "ibm866",
  874: "windows-874",
  936: "gb18030",
  54936: "gb18030",
  950: "big5",
  932: "shift_jis",
  949: "euc-kr",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  65001: "utf-8"
};
var strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
var cachedWindowsFallbackEncoding;
var fallbackDecoderCache = /* @__PURE__ */ new Map();
function parseWindowsCodePage(output) {
  const match = /\b(\d{3,5})\b/.exec(output);
  if (!match) return null;
  const cp = Number.parseInt(match[1], 10);
  const mapped = WINDOWS_CODEPAGE_LABELS[cp];
  return mapped && mapped !== "utf-8" ? mapped : null;
}
function stripTrailingIncompleteUtf8(buf) {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  const minIdx = Math.max(0, buf.length - 4);
  while (i >= minIdx && (buf[i] & 192) === 128) {
    i--;
  }
  if (i < minIdx) return buf;
  const lead = buf[i];
  if ((lead & 128) === 0) return buf;
  let expectedLen = 0;
  if ((lead & 224) === 192) expectedLen = 2;
  else if ((lead & 240) === 224) expectedLen = 3;
  else if ((lead & 248) === 240) expectedLen = 4;
  else return buf;
  return buf.length - i < expectedLen ? buf.subarray(0, i) : buf;
}
function getWindowsSystem32Binary(name) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "";
  if (systemRoot) {
    return {
      bin: path.join(systemRoot, "System32", name),
      cwd: systemRoot
    };
  }
  return { bin: name, cwd: process.cwd() };
}
function getWindowsFallbackEncoding() {
  if (cachedWindowsFallbackEncoding !== void 0) {
    return cachedWindowsFallbackEncoding;
  }
  try {
    const { bin: chcpBin, cwd } = getWindowsSystem32Binary("chcp.com");
    const res = spawnSync(chcpBin, [], {
      cwd,
      encoding: "latin1",
      timeout: 1500,
      windowsHide: true
    });
    if (!res.error && res.status === 0) {
      const mapped = parseWindowsCodePage(res.stdout || "");
      if (mapped) {
        cachedWindowsFallbackEncoding = mapped;
        return cachedWindowsFallbackEncoding;
      }
    }
  } catch {
  }
  cachedWindowsFallbackEncoding = null;
  return null;
}
function decodeProcessOutput(buf, truncated = false, fallbackEncoding) {
  if (buf.length === 0) return "";
  const candidate = truncated ? stripTrailingIncompleteUtf8(buf) : buf;
  try {
    return strictUtf8Decoder.decode(candidate);
  } catch {
    const label = fallbackEncoding ?? (process.platform === "win32" ? getWindowsFallbackEncoding() : null);
    if (!label || label === "utf-8") {
      return buf.toString("utf8");
    }
    try {
      let decoder = fallbackDecoderCache.get(label);
      if (!decoder) {
        decoder = new TextDecoder(label);
        fallbackDecoderCache.set(label, decoder);
      }
      return decoder.decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}
function killChildTree(pid, detached) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
    return;
  }
  try {
    if (detached) {
      process.kill(-pid, "SIGTERM");
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
  }
  setTimeout(() => {
    try {
      if (detached) {
        process.kill(-pid, "SIGKILL");
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
    }
  }, 400).unref();
}
function execBinaryAsync(bin, args, options) {
  return spawnAndCollect(bin, args, false, options);
}
var WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE = /(?<![\\`])(?:\$env:[A-Za-z_][A-Za-z0-9_]*|\$(?:LASTEXITCODE|PSVersionTable|PSScriptRoot|PROFILE)\b)/i;
var WINDOWS_PS_UNQUOTED_SYNTAX_RE = /(?<![\\`])\$(?:HOME|PWD|null|true|false|_)\b|\$\([^)]|@\(|(?:^|[;\r\n])\s*\$[A-Za-z_][A-Za-z0-9_]*\s*=/im;
var WINDOWS_PS_CMDLET_RE = /(?:^|[;|&({\r\n]\s*)(?:Get|Set|New|Remove|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|ConvertTo|ConvertFrom|Export|Import|Invoke|Start|Stop|Restart|Wait|Read|Write|Out|Format|Resolve|Join|Split|Copy|Move|Rename|Clear|Add|Push|Pop|Enable|Disable)-[A-Z][A-Za-z0-9]*\b(?!-)/;
var EXPLICIT_POWERSHELL_INVOCATION_RE = /^\s*(?:["']?)(?:pwsh|powershell)(?:\.exe)?(?:["']?)(?:\s|$)/i;
var PS_NON_INVOCATION_TAIL_RE = /^(?:[|;&+}=),*?]|(?:[1-6*])?>|-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|replace|split|join|in|notin|contains|notcontains|is|isnot|as|and|or|xor|shl|shr|band|bor|bxor)\b|-f\b|$)/i;
var PS_UTF8_PREFIX = "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; $OutputEncoding = [System.Text.UTF8Encoding]::new($false);";
function stripQuotedSpans(command, stripDoubleQuotes) {
  let out = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") {
        if (next === "'") {
          i++;
        } else {
          quote = null;
          out += " ";
        }
      }
      continue;
    }
    if (quote === '"') {
      if ((ch === "\\" || ch === "`") && next === '"') {
        i++;
        if (!stripDoubleQuotes) out += ch + next;
        continue;
      }
      if (ch === '"') {
        if (next === '"') {
          i++;
          if (!stripDoubleQuotes) out += '""';
        } else {
          quote = null;
          out += stripDoubleQuotes ? " " : '"';
        }
        continue;
      }
      if (!stripDoubleQuotes) out += ch;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      out += " ";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      out += stripDoubleQuotes ? " " : '"';
      continue;
    }
    out += ch;
  }
  return out;
}
function needsPowerShellOnWindows(command) {
  if (!command || EXPLICIT_POWERSHELL_INVOCATION_RE.test(command)) {
    return false;
  }
  const withoutSingle = stripQuotedSpans(command, false);
  if (WINDOWS_PS_DOUBLE_QUOTABLE_VAR_RE.test(withoutSingle)) {
    return true;
  }
  const unquoted = stripQuotedSpans(command, true);
  return WINDOWS_PS_UNQUOTED_SYNTAX_RE.test(unquoted) || WINDOWS_PS_CMDLET_RE.test(unquoted);
}
function formatPowerShellCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || trimmed[0] !== '"' && trimmed[0] !== "'") {
    return command;
  }
  const quote = trimmed[0];
  let idx = 1;
  while (idx < trimmed.length) {
    if (quote === '"' && trimmed[idx] === "`" && idx + 1 < trimmed.length) {
      idx += 2;
      continue;
    }
    if (trimmed[idx] === quote) {
      if (trimmed[idx + 1] === quote) {
        idx += 2;
        continue;
      }
      const afterQuote = trimmed.slice(idx + 1);
      if (!/^\s+/.test(afterQuote)) {
        return command;
      }
      const rest = afterQuote.trimStart();
      if (rest && !PS_NON_INVOCATION_TAIL_RE.test(rest)) {
        return `& ${trimmed}`;
      }
      return command;
    }
    idx++;
  }
  return command;
}
function buildPowerShellUtf8Command(command) {
  return `${PS_UTF8_PREFIX} ${formatPowerShellCommand(command)}`;
}
var cachedWindowsPowerShell;
var cachedWindowsPowerShellExecPath = null;
var pendingWindowsPowerShellProbe = null;
async function defaultProbeWindowsShell(bin) {
  const { bin: whereBin, cwd } = getWindowsSystem32Binary("where.exe");
  const exeQuery = bin.toLowerCase().endsWith(".exe") ? bin : `${bin}.exe`;
  const whereRes = await execBinaryAsync(whereBin, [exeQuery], {
    cwd,
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  if (!whereRes.error && !whereRes.timedOut) {
    if (whereRes.exitCode !== 0) return false;
    const resolved = whereRes.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.exe$/i.test(line));
    if (!resolved) return false;
    cachedWindowsPowerShellExecPath = resolved;
    return true;
  }
  const res = await execBinaryAsync(
    exeQuery,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    {
      cwd,
      timeoutMs: 3e3,
      maxOutputBytes: 4096
    }
  );
  if (!res.error && !res.timedOut && res.exitCode === 0) {
    cachedWindowsPowerShellExecPath = exeQuery;
    return true;
  }
  return false;
}
async function resolveWindowsPowerShell(probe = defaultProbeWindowsShell) {
  if (cachedWindowsPowerShell !== void 0) {
    return cachedWindowsPowerShell;
  }
  if (pendingWindowsPowerShellProbe) {
    return pendingWindowsPowerShellProbe;
  }
  pendingWindowsPowerShellProbe = (async () => {
    try {
      cachedWindowsPowerShellExecPath = null;
      if (await probe("pwsh")) {
        cachedWindowsPowerShell = "pwsh";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      if (await probe("powershell.exe")) {
        cachedWindowsPowerShell = "powershell.exe";
        return cachedWindowsPowerShell;
      }
      cachedWindowsPowerShellExecPath = null;
      cachedWindowsPowerShell = null;
      return null;
    } finally {
      pendingWindowsPowerShellProbe = null;
    }
  })();
  return pendingWindowsPowerShellProbe;
}
async function runShellCommandAsync(command, options) {
  if (process.platform === "win32" && needsPowerShellOnWindows(command)) {
    const psBin = await resolveWindowsPowerShell();
    if (psBin) {
      const utf8Command = buildPowerShellUtf8Command(command);
      return spawnAndCollect(
        cachedWindowsPowerShellExecPath ?? psBin,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8Command],
        false,
        options
      );
    }
  }
  return spawnAndCollect(command, [], true, options);
}
function spawnAndCollect(commandOrBin, args, shell, options) {
  const startMs = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const detached = process.platform !== "win32";
  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];
    let child;
    try {
      child = spawn(commandOrBin, args, {
        cwd: options.cwd,
        shell,
        detached,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - startMs,
        stdout: "",
        stderr: "",
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    let settleFallbackTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child.pid, detached);
      settleFallbackTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGKILL");
      }, 1500);
      settleFallbackTimer.unref();
    }, Math.max(100, options.timeoutMs));
    timer.unref();
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (settleFallbackTimer) clearTimeout(settleFallbackTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startMs,
        stdout: decodeProcessOutput(Buffer.concat(stdoutChunks), stdoutTruncated),
        stderr: decodeProcessOutput(Buffer.concat(stderrChunks), stderrTruncated),
        truncated: stdoutTruncated || stderrTruncated,
        error
      });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdoutBytes >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        stdoutTruncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderrBytes >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = maxOutputBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += remaining;
        stderrTruncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("error", (err) => {
      finish(null, null, err.message);
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
var cachedRgAvailable = null;
async function isRipgrepAvailable() {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  const res = await execBinaryAsync("rg", ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 2e3,
    maxOutputBytes: 4096
  });
  cachedRgAvailable = !res.error && res.exitCode === 0;
  return cachedRgAvailable;
}

// src/utils/fs-utils.ts
import { promises as fs } from "node:fs";
import os from "node:os";
import path2 from "node:path";
var DEFAULT_IGNORE_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "vendor"
]);
function expandHome(inputPath) {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path2.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
function resolvePath(inputPath, baseDir) {
  const expanded = expandHome(inputPath.trim());
  const root = baseDir ? path2.resolve(expandHome(baseDir)) : process.cwd();
  return path2.isAbsolute(expanded) ? path2.normalize(expanded) : path2.resolve(root, expanded);
}
function toPosixPath(p) {
  return p.split(path2.sep).join("/");
}
function isLikelyBinary(buf) {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
async function readTextFile(filePath, maxBytes = 10 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File exceeds maximum size (${stat.size} bytes > ${maxBytes} bytes): ${filePath}`
    );
  }
  const buf = await fs.readFile(filePath);
  if (isLikelyBinary(buf)) {
    throw new Error(`Binary file cannot be read as text: ${filePath}`);
  }
  const content = buf.toString("utf8");
  let crlfCount = 0;
  let lfOnlyCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      if (i > 0 && content[i - 1] === "\r") crlfCount++;
      else lfOnlyCount++;
    }
  }
  const eol = crlfCount > lfOnlyCount ? "\r\n" : "\n";
  return { content, eol, size: stat.size, mode: stat.mode & 4095, rawBuffer: buf };
}
function globToRegExp(pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i += 1;
    } else if (ch === "[") {
      const close = normalized.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i += 1;
      } else {
        let inner = normalized.slice(i + 1, close).replace(/\\/g, "\\\\");
        if (inner.startsWith("!")) inner = "^" + inner.slice(1);
        re += `[${inner}]`;
        i = close + 1;
      }
    } else if (ch === "{") {
      const close = findMatchingBrace(normalized, i);
      if (close === -1) {
        re += "\\{";
        i += 1;
      } else {
        const parts = splitBraceAlternatives(normalized.slice(i + 1, close));
        const sub = parts.map((part) => globToRegExp(part).source.slice(1, -1)).join("|");
        re += `(?:${sub})`;
        i = close + 1;
      }
    } else if (".+^$()|\\".includes(ch)) {
      re += "\\" + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  re += "$";
  try {
    return new RegExp(re);
  } catch (err) {
    throw new Error(
      `Invalid glob pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
function findMatchingBrace(str, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
function splitBraceAlternatives(inner) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}
async function walkFiles(rootDir, options = {}) {
  const maxFiles = options.maxFiles ?? 5e3;
  const maxDepth = options.maxDepth ?? 32;
  const includeHidden = options.includeHidden ?? false;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const fileFilter = options.fileFilter;
  const files = [];
  let truncated = false;
  async function visit(dir, relDir, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const subdirs = [];
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      if (!includeHidden && name.startsWith(".")) {
        if (!(entry.isDirectory() && name === ".agents")) {
          continue;
        }
      }
      const absPath = path2.join(dir, name);
      const relPosix = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        subdirs.push({ abs: absPath, rel: relPosix });
      } else if (entry.isFile()) {
        if (fileFilter && !fileFilter(relPosix)) continue;
        files.push(relPosix);
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
    const batchSize = 8;
    for (let i = 0; i < subdirs.length && !truncated; i += batchSize) {
      const slice = subdirs.slice(i, i + batchSize);
      await Promise.all(slice.map((sub) => visit(sub.abs, sub.rel, depth + 1)));
    }
  }
  await visit(rootDir, "", 0);
  return { files, truncated };
}

// src/utils/output-filter.ts
var ANSI_REGEX = (
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g
);
function stripAnsi(text) {
  return text.replace(ANSI_REGEX, "");
}
function normalizeTerminalOutput(raw) {
  const clean = stripAnsi(raw).replace(/\r\n/g, "\n");
  return clean.split("\n").map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? "";
  }).join("\n").trimEnd();
}
var DEFAULT_INLINE_MAX_BYTES = 8800;
function sliceUtf8Bytes(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let bytes = 0;
  let endIndex = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const unitLen = cp > 65535 ? 2 : 1;
    const chBytes = cp <= 127 ? 1 : cp <= 2047 ? 2 : cp <= 65535 ? 3 : 4;
    if (bytes + chBytes > limit) break;
    bytes += chBytes;
    i += unitLen;
    endIndex = i;
  }
  return text.slice(0, endIndex);
}
function truncateWithByteNotice(text, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  const limit = Math.trunc(maxBytes);
  if (limit <= 0) return "";
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= limit) return text;
  if (limit < 56) {
    if (limit <= 3) return sliceUtf8Bytes(text, limit);
    return `${sliceUtf8Bytes(text, limit - 3)}...`;
  }
  const maxNoticeBytes = Buffer.byteLength(
    `
... [truncated: showed ${totalBytes} of ${totalBytes} bytes]`,
    "utf8"
  );
  const cutoffBytes = Math.max(0, limit - maxNoticeBytes);
  let slice = sliceUtf8Bytes(text, cutoffBytes);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > 0 && Buffer.byteLength(slice.slice(0, lastNewline), "utf8") > cutoffBytes * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const shownBytes = Buffer.byteLength(slice, "utf8");
  const result = `${slice}
... [truncated: showed ${shownBytes} of ${totalBytes} bytes]`;
  return Buffer.byteLength(result, "utf8") <= limit ? result : sliceUtf8Bytes(result, limit);
}
function sliceSafeChars(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  let end = limit;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 55296 && lastCode <= 56319) {
    end -= 1;
  }
  return text.slice(0, end);
}
function truncateWithNotice(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  const limit = Math.trunc(maxChars);
  if (limit <= 0) return "";
  if (text.length <= limit) return text;
  if (limit < 48) {
    if (limit <= 3) return sliceSafeChars(text, limit);
    return `${sliceSafeChars(text, limit - 3)}...`;
  }
  const maxNoticeLen = `
... [truncated: showed ${text.length} of ${text.length} chars]`.length;
  const cutoff = Math.max(0, limit - maxNoticeLen);
  let slice = sliceSafeChars(text, cutoff);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline > cutoff * 0.6) {
    slice = slice.slice(0, lastNewline);
  }
  const result = `${slice}
... [truncated: showed ${slice.length} of ${text.length} chars]`;
  return result.length <= limit ? result : sliceSafeChars(result, limit);
}
function fitSectionsToBudget(sections, maxChars, separator = "\n\n") {
  if (sections.length === 0 || !Number.isFinite(maxChars) || maxChars <= 0) return "";
  const joined = sections.join(separator);
  if (joined.length <= maxChars) return joined;
  const sepTotal = separator.length * (sections.length - 1);
  if (sepTotal >= maxChars) {
    return truncateWithNotice(joined, maxChars);
  }
  let remainingBudget = maxChars - sepTotal;
  const budgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, len: s.length })).sort((a, b) => a.len - b.len);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBudget / remainingCount);
    const item = order[i];
    if (item.len <= share) {
      budgets[item.idx] = item.len;
      remainingBudget -= item.len;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBudget / rem);
        budgets[order[j].idx] = alloc;
        remainingBudget -= alloc;
      }
      break;
    }
  }
  const fitted = sections.map((sec, idx) => truncateWithNotice(sec, budgets[idx] ?? 0)).join(separator);
  return fitted.length <= maxChars ? fitted : truncateWithNotice(fitted, maxChars);
}
function fitSectionsToByteBudget(sections, maxChars, maxBytes, separator = "\n\n") {
  const charFitted = fitSectionsToBudget(sections, maxChars, separator);
  if (maxBytes === void 0) {
    return charFitted;
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  if (Buffer.byteLength(charFitted, "utf8") <= maxBytes) {
    return charFitted;
  }
  const sepBytes = Buffer.byteLength(separator, "utf8") * (sections.length - 1);
  if (sepBytes >= maxBytes) {
    return truncateWithByteNotice(charFitted, maxBytes);
  }
  let remainingBytes = maxBytes - sepBytes;
  const byteBudgets = new Array(sections.length).fill(0);
  const order = sections.map((s, idx) => ({ idx, bytes: Buffer.byteLength(s, "utf8") })).sort((a, b) => a.bytes - b.bytes);
  for (let i = 0; i < order.length; i++) {
    const remainingCount = order.length - i;
    const share = Math.floor(remainingBytes / remainingCount);
    const item = order[i];
    if (item.bytes <= share) {
      byteBudgets[item.idx] = item.bytes;
      remainingBytes -= item.bytes;
    } else {
      for (let j = i; j < order.length; j++) {
        const rem = order.length - j;
        const alloc = Math.floor(remainingBytes / rem);
        byteBudgets[order[j].idx] = alloc;
        remainingBytes -= alloc;
      }
      break;
    }
  }
  let fitted = sections.map((sec, idx) => truncateWithByteNotice(sec, byteBudgets[idx] ?? 0)).join(separator);
  if (fitted.length > maxChars) {
    fitted = truncateWithNotice(fitted, maxChars);
  }
  return Buffer.byteLength(fitted, "utf8") <= maxBytes ? fitted : truncateWithByteNotice(fitted, maxBytes);
}
var ERROR_LINE_PATTERN = /(?:\berr!|\b(?:error|fail|failed|failing|exception|traceback|panic|fatal|assertion|syntaxerror|typeerror|referenceerror|zoderror|validationerror|ts\d{4}|e\d{4}|cannot find|not found|unexpected|undefined)\b|caused by:|application failed to start|compilation error|<<<\s*(?:failure|error)|找不到符号|符号:|位置:)/i;
var ROOT_CAUSE_HEADER_PATTERN = /(?:^\s*(?:description|action):|caused by:|application failed to start|⎯+\s*failed tests|compilation error)/i;
var JSON_INFO_LOG_PATTERNS = [
  /^\s*\{"level":(?:10|20|30)\b/,
  /^\s*\{[^}]*"level"\s*:\s*"(?:trace|debug|info)"/i
];
var ALWAYS_NOISE_LINE_PATTERNS = [
  /^\[ERROR\]\s*(?:To see the full stack trace|Re-run Maven using the -X|For more information about the errors|\[Help \d+\]|->\s*\[Help \d+\])/i,
  /^\(node:\d+\)\s*ExperimentalWarning:/,
  /^\(Use `node --trace-warnings/
];
function isFailureNoiseLine(line) {
  if (ALWAYS_NOISE_LINE_PATTERNS.some((re) => re.test(line))) return true;
  if (JSON_INFO_LOG_PATTERNS.some((re) => re.test(line))) {
    return !/"statusCode"\s*:\s*5\d\d|\b(?:error|exception|failed|fatal)\b/i.test(line);
  }
  return false;
}
var SUMMARY_LINE_PATTERN = /\b(passed|tests?|specs?|suites?|ok|warnings?|errors?|built in|compiled|done in|finished)\b/i;
function formatCompactCommandOutput(params) {
  const out = normalizeTerminalOutput(params.stdout);
  const err = normalizeTerminalOutput(params.stderr);
  const combined = [out, err].filter(Boolean).join("\n");
  if (params.error) {
    return truncateWithNotice(`spawn error: ${params.error}`, params.maxChars);
  }
  if (params.timedOut) {
    const tail = getTailLines(combined, 20);
    return truncateWithNotice(
      tail ? `TIMED OUT
${tail}` : "TIMED OUT (no output)",
      params.maxChars
    );
  }
  if (params.exitCode === 0) {
    if (!combined) return "OK";
    const lines2 = combined.split("\n").map((l) => l.trim()).filter(Boolean);
    const summaryLines = lines2.filter((l) => SUMMARY_LINE_PATTERN.test(l));
    const picked = summaryLines.length > 0 ? summaryLines.slice(-2) : lines2.length <= 2 ? lines2 : [lines2[lines2.length - 1]];
    return truncateWithNotice(picked.join(" | "), Math.min(params.maxChars, 320));
  }
  const rawLines = combined.split("\n");
  const filteredLines = rawLines.filter((line) => !isFailureNoiseLine(line));
  const lines = filteredLines.length > 0 ? filteredLines : rawLines;
  const cleanedCombined = lines.join("\n");
  if (cleanedCombined.length <= params.maxChars) {
    return cleanedCombined || `Exited with code ${params.exitCode ?? "unknown"}`;
  }
  const keepIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ROOT_CAUSE_HEADER_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 8);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    } else if (ERROR_LINE_PATTERN.test(line)) {
      const from = Math.max(0, i - 1);
      const to = Math.min(lines.length - 1, i + 3);
      for (let j = from; j <= to; j++) keepIndices.add(j);
    }
  }
  const tailStart = Math.max(0, lines.length - 12);
  for (let i = tailStart; i < lines.length; i++) {
    keepIndices.add(i);
  }
  const sorted = [...keepIndices].sort((a, b) => a - b);
  const outLines = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev !== -1 && idx > prev + 1) {
      outLines.push(`... (${idx - prev - 1} lines omitted) ...`);
    }
    outLines.push(lines[idx]);
    prev = idx;
  }
  return truncateWithNotice(outLines.join("\n"), params.maxChars);
}
function getTailLines(text, count) {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-count).join("\n");
}

// src/tools/apply-edits.ts
function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}
function offsetToLine(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}
function getLineWindowOffsets(text, lineStarts, startLine, endLine) {
  if (startLine !== void 0 && (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (endLine !== void 0 && (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }
  const totalLines = lineStarts.length;
  const sLine = startLine !== void 0 ? Math.trunc(startLine) : 1;
  const eLine = endLine !== void 0 ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;
  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }
  const windowStart = lineStarts[sLine - 1];
  const windowEnd = eLine < totalLines ? lineStarts[eLine] : text.length;
  return { windowStart, windowEnd };
}
var MAX_NEARBY_LINES = 26;
function formatNearbyLines(text, startLine, endLine) {
  const lines = text.split("\n");
  if (startLine === void 0 && endLine === void 0) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`
    );
  }
  const extra = truncated ? `
    ... (${rawTo - to} more lines in range omitted)` : "";
  return `
  Nearby lines (${from}-${to}):
${snippet.join("\n")}${extra}`;
}
function extractLineTokens(trimmedLine) {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine.split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 2);
}
function findClosestRegionSnippet(normalizedContent, normTarget, rangeStartLine, rangeEndLine) {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";
  const targetLines = normTarget.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";
  const firstAnchor = targetLines.find((l) => l.length >= 6) ?? targetLines[0];
  let longestAnchor = targetLines[0];
  for (const tl of targetLines) {
    if (tl.length > longestAnchor.length) longestAnchor = tl;
  }
  const anchors = [firstAnchor];
  if (longestAnchor !== firstAnchor) anchors.push(longestAnchor);
  const lastAnchor = targetLines[targetLines.length - 1];
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
    (rangeEndLine ?? trimmedFileLines.length) - 1
  );
  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i];
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
      if (hits >= 2 || hits >= 1 && primaryTokens.size <= 2 && hits === primaryTokens.size) {
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
    if (score >= 2 && targetLines.length > 1) {
      const lookahead = Math.min(targetLines.length, 6);
      for (let k = 1; k < lookahead && i + k < trimmedFileLines.length; k++) {
        const nextLine = trimmedFileLines[i + k];
        const tgtLine = targetLines[k];
        if (nextLine && tgtLine && (nextLine === tgtLine || tgtLine.length >= 8 && nextLine.includes(tgtLine))) {
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
  const snippet = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`
    );
  }
  return `
  Closest match near line ${bestIdx + 1} (lines ${from}-${to}):
${snippet.join("\n")}`;
}
function planHunksForContent(normalizedContent, hunks, displayPath) {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans = [];
  const errors = [];
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
        hunk.endLine
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const foundOffsets = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }
    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== void 0 || hunk.endLine !== void 0;
      const rangeNote = hasRange ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}` : "";
      let hint = "";
      if (hasRange) {
        const globalOffsets = [];
        let gPos = 0;
        while (gPos <= normalizedContent.length - normTarget.length && globalOffsets.length < 5) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets.map((o) => `L${offsetToLine(lineStarts, o)}`).join(", ");
          hint = ` Exact match found outside range at ${hitLines} \u2014 adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint = findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) || findClosestRegionSnippet(normalizedContent, normTarget) || formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`
      );
      continue;
    }
    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets.slice(0, 10).map((o) => offsetToLine(lineStarts, o)).join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`
      );
      continue;
    }
    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx
      });
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1];
    const curr = spans[i];
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`
      );
    }
  }
  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }
  const pieces = [];
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
    errors: []
  };
}
function countLines(text) {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}
function normalizeForCompare(p) {
  const resolved = path3.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function isStrictlyInsideDir(candidatePath, rootDir) {
  const rel = path3.relative(
    normalizeForCompare(rootDir),
    normalizeForCompare(candidatePath)
  );
  return rel !== "" && !rel.startsWith("..") && !path3.isAbsolute(rel);
}
function isInsideGitDir(candidatePath, rootDir) {
  const rel = toPosixPath(
    path3.relative(normalizeForCompare(rootDir), normalizeForCompare(candidatePath))
  );
  return rel === ".git" || rel.startsWith(".git/");
}
function isCaseInsensitivePlatform() {
  return process.platform === "win32" || process.platform === "darwin";
}
function normalizeEntryName(name) {
  return isCaseInsensitivePlatform() ? name.toLowerCase() : name;
}
async function canonicalizePreserveLeaf(absPath) {
  const normalized = path3.resolve(absPath);
  const parentDir = path3.dirname(normalized);
  const leaf = path3.basename(normalized);
  if (parentDir === normalized) return normalized;
  const tailSegments = [leaf];
  let current = parentDir;
  while (true) {
    try {
      const realAncestor = await fs2.realpath(current);
      return path3.join(realAncestor, ...tailSegments.reverse());
    } catch {
      const next = path3.dirname(current);
      if (next === current) {
        return normalized;
      }
      tailSegments.push(path3.basename(current));
      current = next;
    }
  }
}
async function writeFileAtomically(params) {
  const { target, content, mode, originalSymlinkTarget, onCommitted } = params;
  const dir = path3.dirname(target);
  await fs2.mkdir(dir, { recursive: true });
  const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs2.writeFile(tmpPath, content, "utf8");
    if (mode !== null && process.platform !== "win32") {
      await fs2.chmod(tmpPath, mode);
    }
  } catch (tmpErr) {
    try {
      await fs2.unlink(tmpPath);
    } catch {
    }
    throw tmpErr;
  }
  try {
    await fs2.rename(tmpPath, target);
    onCommitted();
  } catch (renameErr) {
    try {
      await fs2.unlink(tmpPath);
    } catch {
    }
    onCommitted();
    if (originalSymlinkTarget) {
      try {
        await fs2.unlink(target);
      } catch {
      }
    }
    await fs2.writeFile(target, content, "utf8");
    if (mode !== null && process.platform !== "win32") {
      try {
        await fs2.chmod(target, mode);
      } catch {
      }
    }
    void renameErr;
  }
}
function sortDirsDeepestFirst(dirs) {
  const unique = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    const key = normalizeForCompare(dir);
    if (!unique.has(key)) {
      unique.set(key, dir);
    }
  }
  return [...unique.values()].sort((a, b) => {
    const depthDiff = toPosixPath(b).split("/").length - toPosixPath(a).split("/").length;
    if (depthDiff !== 0) return depthDiff;
    return b.length - a.length;
  });
}
async function simulatePrunedDirs(plans, realBaseCwd) {
  const candidateStartDirs = [];
  const populatedDirs = /* @__PURE__ */ new Set();
  const keptDestKeys = /* @__PURE__ */ new Set();
  const markAncestorsPopulated = (filePath) => {
    keptDestKeys.add(normalizeForCompare(filePath));
    let dir = path3.dirname(filePath);
    while (isStrictlyInsideDir(dir, realBaseCwd)) {
      const key = normalizeForCompare(dir);
      if (populatedDirs.has(key)) break;
      populatedDirs.add(key);
      dir = path3.dirname(dir);
    }
  };
  for (const plan of plans) {
    if (plan.kind === "write") {
      markAncestorsPopulated(plan.writeTargetPath);
    } else if (plan.kind === "move") {
      markAncestorsPopulated(plan.destPath);
      if (plan.pruneEmptyDirs) {
        candidateStartDirs.push(path3.dirname(plan.sourcePath));
      }
    } else if (plan.kind === "delete" && plan.pruneEmptyDirs) {
      candidateStartDirs.push(path3.dirname(plan.sourcePath));
    }
  }
  if (candidateStartDirs.length === 0) return [];
  const removedByDir = /* @__PURE__ */ new Map();
  const markRemoved = (entryPath) => {
    const parentKey = normalizeForCompare(path3.dirname(entryPath));
    let set = removedByDir.get(parentKey);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      removedByDir.set(parentKey, set);
    }
    set.add(normalizeEntryName(path3.basename(entryPath)));
  };
  for (const plan of plans) {
    if (plan.kind === "delete" || plan.kind === "move") {
      if (!keptDestKeys.has(normalizeForCompare(plan.sourcePath))) {
        markRemoved(plan.sourcePath);
      }
    }
  }
  const prunedDirs = [];
  const prunedKeys = /* @__PURE__ */ new Set();
  for (const startDir of sortDirsDeepestFirst(candidateStartDirs)) {
    let current = startDir;
    while (isStrictlyInsideDir(current, realBaseCwd) && !isInsideGitDir(current, realBaseCwd)) {
      const key = normalizeForCompare(current);
      if (prunedKeys.has(key)) {
        current = path3.dirname(current);
        continue;
      }
      if (populatedDirs.has(key)) break;
      let lst;
      try {
        lst = await fs2.lstat(current);
      } catch {
        break;
      }
      if (lst.isSymbolicLink() || !lst.isDirectory()) break;
      let entries;
      try {
        entries = await fs2.readdir(current);
      } catch {
        break;
      }
      const removedInThisDir = removedByDir.get(key);
      const allRemoved = entries.every(
        (name) => removedInThisDir?.has(normalizeEntryName(name)) ?? false
      );
      if (!allRemoved) break;
      prunedKeys.add(key);
      prunedDirs.push(current);
      markRemoved(current);
      current = path3.dirname(current);
    }
  }
  return prunedDirs;
}
async function commitPlannedOperations(plans, realBaseCwd) {
  const undoLog = [];
  const sidecarBackups = [];
  const stagedMoveSources = /* @__PURE__ */ new Map();
  const prunedDirs = [];
  const needsTxDir = plans.some((p) => p.kind === "delete" || p.kind === "move");
  const txDir = path3.join(
    realBaseCwd,
    `.agy-fast-tx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  let txDirCreated = false;
  let txSeq = 0;
  const ensureTxDir = async () => {
    if (!txDirCreated) {
      await fs2.mkdir(txDir, { recursive: true });
      txDirCreated = true;
    }
  };
  const stageMoveOut = async (sourcePath, allowSameDirFallback) => {
    await ensureTxDir();
    const txSlot = path3.join(txDir, `item-${txSeq++}`);
    try {
      await fs2.rename(sourcePath, txSlot);
      undoLog.push({ kind: "restore-rename", from: txSlot, to: sourcePath });
      return txSlot;
    } catch (err) {
      if (err?.code === "EXDEV") {
        if (allowSameDirFallback) {
          const localBackup = `${sourcePath}.agy-fast-del-${process.pid}-${Date.now()}-${txSeq++}`;
          await fs2.rename(sourcePath, localBackup);
          sidecarBackups.push(localBackup);
          undoLog.push({ kind: "restore-rename", from: localBackup, to: sourcePath });
          return localBackup;
        }
        throw new Error(
          `Cannot atomically stage '${sourcePath}' across filesystems (EXDEV)`
        );
      }
      throw err;
    }
  };
  try {
    if (needsTxDir) {
      for (const plan of plans) {
        if (plan.kind === "delete") {
          await stageMoveOut(plan.sourcePath, !plan.pruneEmptyDirs);
        }
      }
      for (const plan of plans) {
        if (plan.kind === "move") {
          const stagedSrc = await stageMoveOut(plan.sourcePath, false);
          stagedMoveSources.set(plan, stagedSrc);
        }
      }
      for (const plan of plans) {
        if (plan.kind === "move" && plan.destExisted && !plan.isCaseOnlySelfRename) {
          let stillExists = false;
          try {
            await fs2.lstat(plan.destPath);
            stillExists = true;
          } catch (err) {
            if (err?.code !== "ENOENT") {
              throw err;
            }
          }
          if (stillExists) {
            await stageMoveOut(plan.destPath, true);
          }
        }
      }
    }
    for (const plan of plans) {
      if (plan.kind !== "move") continue;
      if (plan.newContent === void 0) {
        await fs2.mkdir(path3.dirname(plan.destPath), { recursive: true });
        const stagedSrc = stagedMoveSources.get(plan);
        await fs2.rename(stagedSrc, plan.destPath);
        undoLog.push({ kind: "unmove-to-tx", from: plan.destPath, to: stagedSrc });
      } else {
        await writeFileAtomically({
          target: plan.destPath,
          content: plan.newContent,
          mode: plan.originalMode ?? null,
          onCommitted: () => {
            undoLog.push({ kind: "unlink-created", target: plan.destPath });
          }
        });
      }
    }
    for (const plan of plans) {
      if (plan.kind !== "write") continue;
      await writeFileAtomically({
        target: plan.writeTargetPath,
        content: plan.newContent,
        mode: plan.originalMode,
        originalSymlinkTarget: plan.originalSymlinkTarget,
        onCommitted: () => {
          undoLog.push({ kind: "restore-write", plan });
        }
      });
    }
    const candidateStartDirs = [];
    for (const plan of plans) {
      if ((plan.kind === "delete" || plan.kind === "move") && plan.pruneEmptyDirs) {
        candidateStartDirs.push(path3.dirname(plan.sourcePath));
      }
    }
    const prunedKeys = /* @__PURE__ */ new Set();
    for (const startDir of sortDirsDeepestFirst(candidateStartDirs)) {
      let current = startDir;
      while (isStrictlyInsideDir(current, realBaseCwd) && !isInsideGitDir(current, realBaseCwd)) {
        const key = normalizeForCompare(current);
        if (prunedKeys.has(key)) {
          current = path3.dirname(current);
          continue;
        }
        let lst;
        try {
          lst = await fs2.lstat(current);
        } catch {
          break;
        }
        if (lst.isSymbolicLink() || !lst.isDirectory()) break;
        let entries;
        try {
          entries = await fs2.readdir(current);
        } catch {
          break;
        }
        if (entries.length > 0) break;
        try {
          await fs2.rmdir(current);
        } catch (rmdirErr) {
          const code = rmdirErr?.code;
          if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT") {
            break;
          }
          throw rmdirErr;
        }
        prunedKeys.add(key);
        prunedDirs.push(current);
        undoLog.push({ kind: "mkdir", dir: current });
        current = path3.dirname(current);
      }
    }
    if (txDirCreated) {
      await fs2.rm(txDir, { recursive: true, force: true }).catch(() => {
      });
    }
    for (const backup of sidecarBackups) {
      await fs2.unlink(backup).catch(() => {
      });
    }
    return { prunedDirs };
  } catch (err) {
    for (let i = undoLog.length - 1; i >= 0; i--) {
      const action = undoLog[i];
      try {
        if (action.kind === "mkdir") {
          await fs2.mkdir(action.dir, { recursive: true });
        } else if (action.kind === "unlink-created") {
          await fs2.unlink(action.target);
        } else if (action.kind === "unmove-to-tx") {
          await fs2.mkdir(path3.dirname(action.to), { recursive: true });
          await fs2.rename(action.from, action.to);
        } else if (action.kind === "restore-rename") {
          await fs2.mkdir(path3.dirname(action.to), { recursive: true });
          await fs2.rename(action.from, action.to);
        } else if (action.kind === "restore-write") {
          const item = action.plan;
          const target = item.writeTargetPath;
          if (item.originalSymlinkTarget) {
            await fs2.unlink(target).catch(() => {
            });
            await fs2.symlink(item.originalSymlinkTarget, target);
          } else if (item.existed && item.originalBuffer !== null) {
            await fs2.writeFile(target, item.originalBuffer);
            if (item.originalMode !== null && process.platform !== "win32") {
              await fs2.chmod(target, item.originalMode);
            }
          } else if (!item.existed) {
            await fs2.unlink(target);
          }
        }
      } catch {
      }
    }
    if (txDirCreated) {
      await fs2.rmdir(txDir).catch(() => {
      });
    }
    throw err;
  }
}
async function runApplyEdits(input) {
  const parsedEdits = parseMaybeJsonArray(input?.edits);
  if (!parsedEdits.ok) {
    if (parsedEdits.kind === "wrong_type" && (typeof input?.edits === "boolean" || input?.edits === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed (0 files modified)",
          toolName: "apply_edits",
          items: [{ label: "edits", value: input.edits, expected: "an array of edit objects" }],
          fallbackAdvice: "immediately fall back to parallel built-in edit_file / write_file calls for these file(s)."
        }),
        isError: true
      };
    }
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true
    };
  }
  const rawEdits = parsedEdits.value;
  if (rawEdits.length === 0) {
    return {
      text: "Error: 'edits' must be a non-empty array of file edit objects.",
      isError: true
    };
  }
  if (rawEdits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true
    };
  }
  const corruptedItems = [];
  const normalizedEdits = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i];
    if (!isPlainObject(rawEntry)) {
      corruptedItems.push({ label: `edits[${i}]`, value: rawEntry, expected: "an edit object" });
      continue;
    }
    let normalizedHunks;
    if (rawEntry.hunks !== void 0) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks);
      if (!parsedHunks.ok) {
        corruptedItems.push({
          label: `edits[${i}].hunks`,
          value: rawEntry.hunks,
          expected: "an array of hunk objects"
        });
        continue;
      }
      let hunkCorrupted = false;
      for (let j = 0; j < parsedHunks.value.length; j++) {
        if (!isPlainObject(parsedHunks.value[j])) {
          corruptedItems.push({
            label: `edits[${i}].hunks[${j}]`,
            value: parsedHunks.value[j],
            expected: "a hunk object"
          });
          hunkCorrupted = true;
        }
      }
      if (hunkCorrupted) continue;
      normalizedHunks = parsedHunks.value;
    }
    normalizedEdits.push({
      path: rawEntry.path,
      hunks: normalizedHunks,
      create: rawEntry.create,
      overwrite: rawEntry.overwrite,
      delete: rawEntry.delete,
      moveTo: rawEntry.moveTo,
      pruneEmptyDirs: rawEntry.pruneEmptyDirs
    });
  }
  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed (0 files modified)",
        toolName: "apply_edits",
        items: corruptedItems,
        fallbackAdvice: "immediately fall back to parallel built-in edit_file / write_file calls for these file(s)."
      }),
      isError: true
    };
  }
  let validatedVerify = null;
  if (input.verify !== void 0) {
    if (typeof input.verify === "string") {
      if (input.verify.trim()) {
        validatedVerify = { command: input.verify };
      }
    } else if (isPlainObject(input.verify)) {
      const cmd = input.verify.command;
      if (typeof cmd !== "string" || !cmd.trim()) {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.command' must be a non-empty string.",
          isError: true
        };
      }
      if (input.verify.cwd !== void 0 && typeof input.verify.cwd !== "string") {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.cwd' must be a string.",
          isError: true
        };
      }
      validatedVerify = {
        command: cmd,
        cwd: input.verify.cwd,
        timeoutSec: typeof input.verify.timeoutSec === "number" ? input.verify.timeoutSec : void 0
      };
    } else {
      return {
        text: "Validation failed (0 files modified):\n- 'verify' must be a command string or { command, cwd?, timeoutSec? } object.",
        isError: true
      };
    }
  }
  if (input.pruneEmptyDirs !== void 0 && typeof input.pruneEmptyDirs !== "boolean") {
    return {
      text: "Validation failed (0 files modified):\n- 'pruneEmptyDirs' must be a boolean.",
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  let realBaseCwd = baseCwd;
  try {
    realBaseCwd = await fs2.realpath(baseCwd);
  } catch {
  }
  const opItems = [];
  const hunksByTarget = /* @__PURE__ */ new Map();
  const sourceConsumers = /* @__PURE__ */ new Map();
  const destWriters = /* @__PURE__ */ new Map();
  const errors = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const entry = normalizedEdits[i];
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    if (entry.delete !== void 0 && typeof entry.delete !== "boolean") {
      errors.push(`edits[${i}]: 'delete' must be a boolean`);
      continue;
    }
    if (entry.moveTo !== void 0 && (typeof entry.moveTo !== "string" || !entry.moveTo.trim())) {
      errors.push(`edits[${i}]: 'moveTo' must be a non-empty string`);
      continue;
    }
    if (entry.pruneEmptyDirs !== void 0 && typeof entry.pruneEmptyDirs !== "boolean") {
      errors.push(`edits[${i}]: 'pruneEmptyDirs' must be a boolean`);
      continue;
    }
    if (entry.overwrite !== void 0 && typeof entry.overwrite !== "boolean") {
      errors.push(`edits[${i}]: 'overwrite' must be a boolean`);
      continue;
    }
    const absPath = resolvePath(entry.path, baseCwd);
    const relPath = toPosixPath(path3.relative(baseCwd, absPath)) || path3.basename(absPath);
    const hasDelete = entry.delete === true;
    const hasCreate = typeof entry.create === "string";
    const hasMove = typeof entry.moveTo === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;
    if (!hasDelete && !hasCreate && !hasMove && !hasHunks) {
      errors.push(
        `${relPath}: must specify 'hunks', 'create', 'delete: true', or 'moveTo'`
      );
      continue;
    }
    if (hasDelete && (hasCreate || hasHunks || hasMove)) {
      errors.push(
        `${relPath}: cannot combine 'delete' with 'create', 'hunks', or 'moveTo'`
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
      const existingConsumer2 = sourceConsumers.get(sourceKey);
      if (existingConsumer2) {
        errors.push(`${relPath}: duplicate entries cannot mix 'delete' with other edits on the same file`);
        continue;
      }
      const item2 = {
        kind: "delete",
        absPath,
        sourcePath,
        relPath,
        pruneEmptyDirs: effectivePruneEmptyDirs
      };
      sourceConsumers.set(sourceKey, item2);
      opItems.push(item2);
      continue;
    }
    if (hasMove) {
      const sourcePath = await canonicalizePreserveLeaf(absPath);
      const destAbsPath = resolvePath(entry.moveTo, baseCwd);
      const destPath = await canonicalizePreserveLeaf(destAbsPath);
      const destRelPath = toPosixPath(path3.relative(baseCwd, destAbsPath)) || path3.basename(destAbsPath);
      const sourceKey = normalizeForCompare(sourcePath);
      const destKey = normalizeForCompare(destPath);
      if (sourceConsumers.has(sourceKey)) {
        errors.push(
          `${relPath}: duplicate source entry for 'moveTo' (combine 'hunks' and 'moveTo' on the same entry)`
        );
        continue;
      }
      if (destWriters.has(destKey)) {
        errors.push(`${destRelPath}: duplicate destination path across entries`);
        continue;
      }
      const item2 = {
        kind: "move",
        absPath,
        sourcePath,
        destAbsPath,
        destPath,
        relPath,
        destRelPath,
        overwrite: entry.overwrite,
        pruneEmptyDirs: effectivePruneEmptyDirs,
        hunks: hasHunks ? [...entry.hunks] : []
      };
      sourceConsumers.set(sourceKey, item2);
      destWriters.set(destKey, item2);
      opItems.push(item2);
      continue;
    }
    let writeTargetPath = absPath;
    try {
      writeTargetPath = await fs2.realpath(absPath);
    } catch {
      try {
        const realParent = await fs2.realpath(path3.dirname(absPath));
        writeTargetPath = path3.join(realParent, path3.basename(absPath));
      } catch {
      }
    }
    const targetKey = normalizeForCompare(writeTargetPath);
    if (hasCreate) {
      const existingDest2 = destWriters.get(targetKey);
      if (existingDest2) {
        errors.push(
          existingDest2.kind === "hunks" || existingDest2.kind === "create" ? `${relPath}: duplicate entries cannot mix 'create' with other edits` : `${relPath}: duplicate destination path across entries`
        );
        continue;
      }
      const item2 = {
        kind: "create",
        absPath,
        writeTargetPath,
        relPath,
        create: entry.create,
        overwrite: entry.overwrite
      };
      destWriters.set(targetKey, item2);
      opItems.push(item2);
      continue;
    }
    const existingHunks = hunksByTarget.get(targetKey);
    if (existingHunks) {
      existingHunks.hunks.push(...entry.hunks);
      continue;
    }
    const existingDest = destWriters.get(targetKey);
    if (existingDest) {
      errors.push(
        existingDest.kind === "create" ? `${relPath}: duplicate entries cannot mix 'create' with other edits` : `${relPath}: duplicate destination path across entries`
      );
      continue;
    }
    const existingConsumer = sourceConsumers.get(targetKey);
    if (existingConsumer) {
      errors.push(
        `${relPath}: cannot edit a file that is also being deleted or moved in the same batch`
      );
      continue;
    }
    const item = {
      kind: "hunks",
      absPath,
      writeTargetPath,
      relPath,
      hunks: [...entry.hunks]
    };
    hunksByTarget.set(targetKey, item);
    sourceConsumers.set(targetKey, item);
    destWriters.set(targetKey, item);
    opItems.push(item);
  }
  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):
- ${errors.join("\n- ")}`,
      isError: true
    };
  }
  const readyPlans = [];
  const pendingCreates = [];
  const pendingMoves = [];
  for (const item of opItems) {
    if (item.kind === "delete") {
      if (!isStrictlyInsideDir(item.sourcePath, realBaseCwd)) {
        errors.push(
          `${item.relPath}: delete path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`
        );
        continue;
      }
      if (isInsideGitDir(item.sourcePath, realBaseCwd)) {
        errors.push(`${item.relPath}: refusing to delete files inside '.git'`);
        continue;
      }
      let lst;
      try {
        lst = await fs2.lstat(item.sourcePath);
      } catch (err) {
        errors.push(
          `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (lst.isDirectory()) {
        errors.push(
          `${item.relPath}: target path is a directory ('delete' only removes files/symlinks; use pruneEmptyDirs: true to remove empty parent directories)`
        );
        continue;
      }
      readyPlans.push({
        kind: "delete",
        absPath: item.absPath,
        sourcePath: item.sourcePath,
        relPath: item.relPath,
        pruneEmptyDirs: item.pruneEmptyDirs
      });
      continue;
    }
    if (item.kind === "move") {
      if (!isStrictlyInsideDir(item.sourcePath, realBaseCwd)) {
        errors.push(
          `${item.relPath}: move source path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`
        );
        continue;
      }
      if (!isStrictlyInsideDir(item.destPath, realBaseCwd)) {
        errors.push(
          `${item.destRelPath}: move destination path must be strictly inside cwd (${toPosixPath(realBaseCwd)})`
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
      const isCaseOnlySelfRename = isCaseInsensitivePlatform() && normalizeForCompare(item.sourcePath) === normalizeForCompare(item.destPath) && item.sourcePath !== item.destPath;
      let srcLstat;
      try {
        srcLstat = await fs2.lstat(item.sourcePath);
      } catch (err) {
        errors.push(
          `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      if (srcLstat.isDirectory()) {
        errors.push(
          `${item.relPath}: move source is a directory ('moveTo' only moves files/symlinks)`
        );
        continue;
      }
      let newContent;
      let originalMode;
      let hunkCount;
      let lineDelta2;
      if (item.hunks.length > 0) {
        if (srcLstat.isSymbolicLink()) {
          errors.push(
            `${item.relPath}: cannot combine 'moveTo' with 'hunks' on a symbolic link`
          );
          continue;
        }
        let fileData2;
        try {
          fileData2 = await readTextFile(item.sourcePath);
        } catch (err) {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
        const normalizedOriginal2 = fileData2.content.replace(/\r\n/g, "\n");
        const planned2 = planHunksForContent(normalizedOriginal2, item.hunks, item.relPath);
        if (planned2.errors.length > 0) {
          errors.push(...planned2.errors);
          continue;
        }
        newContent = fileData2.eol === "\r\n" ? planned2.newNormalized.replace(/\n/g, "\r\n") : planned2.newNormalized;
        originalMode = fileData2.mode;
        hunkCount = planned2.appliedMatches;
        lineDelta2 = countLines(planned2.newNormalized) - countLines(normalizedOriginal2);
      }
      let destExists = false;
      if (!isCaseOnlySelfRename) {
        try {
          const destLst = await fs2.lstat(item.destPath);
          if (destLst.isDirectory()) {
            errors.push(`${item.destRelPath}: move destination path is a directory`);
            continue;
          }
          if (destLst.isSymbolicLink()) {
            try {
              const destSt = await fs2.stat(item.destPath);
              if (destSt.isDirectory()) {
                errors.push(`${item.destRelPath}: move destination path is a directory`);
                continue;
              }
            } catch (statErr) {
              if (statErr?.code !== "ENOENT") {
                errors.push(
                  `${item.destRelPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`
                );
                continue;
              }
            }
          }
          destExists = true;
        } catch (err) {
          if (err?.code !== "ENOENT") {
            errors.push(
              `${item.destRelPath}: ${err instanceof Error ? err.message : String(err)}`
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
        lineDelta: lineDelta2
      });
      continue;
    }
    if (item.kind === "create") {
      let exists = false;
      let isDanglingSymlink = false;
      let originalBuffer = null;
      let originalMode = null;
      let originalSymlinkTarget = null;
      try {
        const lst = await fs2.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs2.stat(item.writeTargetPath);
            if (st.isDirectory()) {
              errors.push(`${item.relPath}: target path is a directory`);
              continue;
            }
            exists = true;
            originalMode = st.mode & 4095;
            originalBuffer = await fs2.readFile(item.writeTargetPath);
          } catch (statErr) {
            if (statErr?.code === "ENOENT") {
              exists = true;
              isDanglingSymlink = true;
              originalSymlinkTarget = await fs2.readlink(item.writeTargetPath);
            } else {
              errors.push(
                `${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`
              );
              continue;
            }
          }
        } else {
          const st = await fs2.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: target path is a directory`);
            continue;
          }
          exists = true;
          originalMode = st.mode & 4095;
          originalBuffer = await fs2.readFile(item.writeTargetPath);
        }
      } catch (err) {
        if (err?.code === "ENOENT") {
          exists = false;
          originalBuffer = null;
          originalMode = null;
        } else {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
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
        originalSymlinkTarget
      });
      continue;
    }
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }
    const finalContent = fileData.eol === "\r\n" ? planned.newNormalized.replace(/\n/g, "\r\n") : planned.newNormalized;
    const lineDelta = countLines(planned.newNormalized) - countLines(normalizedOriginal);
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
      created: false
    });
  }
  let survivingMoves = pendingMoves;
  while (true) {
    const vacatedKeys = /* @__PURE__ */ new Set();
    for (const p of readyPlans) {
      if (p.kind === "delete") {
        vacatedKeys.add(normalizeForCompare(p.sourcePath));
      }
    }
    for (const m of survivingMoves) {
      vacatedKeys.add(normalizeForCompare(m.item.sourcePath));
    }
    const nextMoves = [];
    let dropped = false;
    for (const m of survivingMoves) {
      if (m.destExists && !m.isCaseOnlySelfRename && !vacatedKeys.has(normalizeForCompare(m.item.destPath)) && !m.item.overwrite) {
        errors.push(
          `${m.item.destRelPath}: move destination already exists (set overwrite: true to replace it)`
        );
        dropped = true;
      } else {
        nextMoves.push(m);
      }
    }
    survivingMoves = nextMoves;
    if (!dropped) break;
  }
  const finalVacatedKeys = /* @__PURE__ */ new Set();
  for (const p of readyPlans) {
    if (p.kind === "delete") {
      finalVacatedKeys.add(normalizeForCompare(p.sourcePath));
    }
  }
  for (const m of survivingMoves) {
    finalVacatedKeys.add(normalizeForCompare(m.item.sourcePath));
  }
  const plans = [...readyPlans];
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
      lineDelta: m.lineDelta
    });
  }
  for (const c of pendingCreates) {
    const targetVacated = finalVacatedKeys.has(normalizeForCompare(c.item.writeTargetPath));
    if (c.exists && !targetVacated && !c.item.overwrite) {
      errors.push(
        c.isDanglingSymlink ? `${c.item.relPath}: dangling symlink already exists (set overwrite: true to replace it)` : `${c.item.relPath}: file already exists (set overwrite: true to replace it)`
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
      created: !effectiveExisted
    });
  }
  const bestEffort = Boolean(input.bestEffort);
  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort ? "Edit aborted (0 files modified):" : "Atomic edit aborted (0 files modified):";
    return {
      text: truncateWithByteNotice(
        `${prefix}
- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  let prunedDirs = [];
  if (!input.dryRun) {
    try {
      const committed = await commitPlannedOperations(plans, realBaseCwd);
      prunedDirs = committed.prunedDirs;
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true
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
      if (p.newContent !== void 0) {
        const delta = p.lineDelta ?? 0;
        const deltaStr2 = delta >= 0 ? `+${delta}` : `${delta}`;
        const matches = p.hunkCount ?? 0;
        return `- ${p.relPath} -> ${p.destRelPath}: moved & updated (${matches} match${matches === 1 ? "" : "es"}), lines ${deltaStr2}`;
      }
      return `- ${p.relPath} -> ${p.destRelPath}: moved`;
    }
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created ? "created" : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });
  const prunedRelPaths = prunedDirs.map(
    (d) => toPosixPath(path3.relative(realBaseCwd, d)) || path3.basename(d)
  );
  const prunedNotice = prunedRelPaths.length > 0 ? `${input.dryRun ? "Would prune" : "Pruned"} empty dir(s): ${prunedRelPaths.join(", ")}` : null;
  if (bestEffort && errors.length > 0) {
    const totalFiles = opItems.length;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const partialHeader = input.dryRun ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):` : `Partial edit applied (${plans.length}/${totalFiles} file(s) written; ${failedFileCount} file(s) failed \u2014 do NOT re-send applied files):`;
    const appliedBody = prunedNotice ? `Applied:
${summaryLines.join("\n")}
${prunedNotice}` : `Applied:
${summaryLines.join("\n")}`;
    const partialParts = [
      partialHeader,
      appliedBody,
      `Failed (fix only these):
- ${errors.join("\n- ")}`
    ];
    if (!input.dryRun && input.verify) {
      partialParts.push(
        "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify."
      );
    }
    return {
      text: truncateWithByteNotice(
        partialParts.join("\n\n"),
        DEFAULT_INLINE_MAX_BYTES
      ),
      isError: true
    };
  }
  const header = input.dryRun ? `Dry run validated ${plans.length} file(s) (0 files modified):` : `Applied edits to ${plans.length} file(s):`;
  const parts = [
    prunedNotice ? `${header}
${summaryLines.join("\n")}
${prunedNotice}` : `${header}
${summaryLines.join("\n")}`
  ];
  if (!input.dryRun && validatedVerify) {
    const verifySpec = validatedVerify;
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const rawTimeoutSec = Number(verifySpec.timeoutSec ?? input.verifyTimeoutSec ?? 60);
    const timeoutMs = (Number.isFinite(rawTimeoutSec) ? Math.max(1, Math.min(300, Math.trunc(rawTimeoutSec))) : 60) * 1e3;
    const rawMaxVerifyChars = Number(input.maxVerifyChars ?? 4e3);
    const maxVerifyChars = Number.isFinite(rawMaxVerifyChars) ? Math.max(300, Math.min(7500, Math.trunc(rawMaxVerifyChars))) : 4e3;
    const res = await runShellCommandAsync(verifySpec.command, {
      cwd: verifyCwd,
      timeoutMs
    });
    const status = res.timedOut ? "TIMEOUT" : res.exitCode === 0 ? "PASS" : `FAIL (exit ${res.exitCode ?? "err"})`;
    const formatted = formatCompactCommandOutput({
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      error: res.error,
      maxChars: maxVerifyChars
    });
    parts.push(
      `
Verify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:
${formatted}`
    );
  }
  const outText = parts.join("\n");
  const finalText = truncateWithByteNotice(outText, DEFAULT_INLINE_MAX_BYTES);
  return { text: finalText, isError: false };
}

// src/tools/batch-search.ts
import { promises as fs3 } from "node:fs";
import path4 from "node:path";

// src/utils/fuzzy-match.ts
function findContiguousIndex(haystack, needle) {
  const maxStart = haystack.length - needle.length;
  for (let start = 0; start <= maxStart; start++) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}
function isAscii(text) {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) return false;
  }
  return true;
}
function subsequenceCost(needle, haystack) {
  if (!needle) return 2147483647;
  if (isAscii(needle) && isAscii(haystack)) {
    const query2 = needle.toLowerCase();
    const lowered2 = haystack.toLowerCase();
    const contiguousAt2 = lowered2.indexOf(query2);
    if (contiguousAt2 >= 0) {
      return contiguousAt2 === 0 ? -100 : -60 + Math.min(25, contiguousAt2);
    }
    let cursor2 = 0;
    let first2 = -1;
    let last2 = -1;
    const hLen = lowered2.length;
    for (let i = 0; i < query2.length; i++) {
      const targetCode = query2.charCodeAt(i);
      while (cursor2 < hLen && lowered2.charCodeAt(cursor2) !== targetCode) cursor2++;
      if (cursor2 === hLen) return void 0;
      if (first2 < 0) first2 = cursor2;
      last2 = cursor2++;
    }
    return Math.max(0, last2 - first2 + 1 - query2.length) - (first2 === 0 ? 20 : 0);
  }
  const lowered = [...haystack.toLowerCase()];
  const query = [...needle.toLowerCase()];
  const contiguousAt = findContiguousIndex(lowered, query);
  if (contiguousAt >= 0) {
    return contiguousAt === 0 ? -100 : -60 + Math.min(25, contiguousAt);
  }
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const ch of query) {
    while (cursor < lowered.length && lowered[cursor] !== ch) cursor++;
    if (cursor === lowered.length) return void 0;
    if (first < 0) first = cursor;
    last = cursor++;
  }
  return Math.max(0, last - first + 1 - query.length) - (first === 0 ? 20 : 0);
}
function scoreSubsequence(query, target) {
  const cost = subsequenceCost(query, target);
  return cost === void 0 ? -1 : Math.max(1, 1e3 - cost);
}
function fuzzyScorePath(query, candidatePosix) {
  const trimmed = query.trim().replace(/\\/g, "/");
  if (!trimmed) return -1;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const slashIdx = candidatePosix.lastIndexOf("/");
  const basename = slashIdx === -1 ? candidatePosix : candidatePosix.slice(slashIdx + 1);
  let totalScore = 0;
  for (const token of tokens) {
    const fullScore = scoreSubsequence(token, candidatePosix);
    if (fullScore < 0) return -1;
    const baseScore = !token.includes("/") ? scoreSubsequence(token, basename) : -1;
    totalScore += baseScore >= 0 ? Math.max(fullScore, baseScore + 45) : fullScore;
    if (basename.toLowerCase() === token.toLowerCase()) totalScore += 60;
  }
  return totalScore;
}
function rankFuzzyPaths(query, candidates, maxResults) {
  const scored = [];
  for (const candidate of candidates) {
    const score = fuzzyScorePath(query, candidate);
    if (score >= 0) scored.push({ path: candidate, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    matches: scored.slice(0, maxResults),
    totalMatched: scored.length
  };
}

// src/tools/batch-search.ts
var READONLY_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "tag",
  "remote"
]);
var FORBIDDEN_GIT_GLOBAL_FLAGS = /* @__PURE__ */ new Set([
  "-c",
  "--config",
  "--config-env",
  "--exec-path",
  "--ext-diff",
  "--textconv",
  "--output",
  "--exec",
  "--upload-pack",
  "--git-dir",
  "--work-tree"
]);
var ALLOWED_BRANCH_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--remotes",
  "--verbose",
  "--list",
  "--show-current",
  "--no-abbrev",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column",
  "--quiet"
]);
var ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--abbrev",
  "--color",
  "--column"
]);
var ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged"
]);
var ALLOWED_BRANCH_COMMIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_BRANCH_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_BRANCH_SHORT_CHARS = /* @__PURE__ */ new Set(["a", "r", "v", "l", "q", "i"]);
var ALLOWED_TAG_BOOL_FLAGS = /* @__PURE__ */ new Set([
  "--list",
  "--no-color",
  "--ignore-case",
  "--omit-empty",
  "--no-column"
]);
var ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--color",
  "--column"
]);
var ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS = /* @__PURE__ */ new Set([
  "--merged",
  "--no-merged"
]);
var ALLOWED_TAG_COMMIT_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at"
]);
var ALLOWED_TAG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--contains",
  "--no-contains",
  "--points-at",
  "--sort",
  "--format"
]);
var ALLOWED_TAG_SHORT_CHARS = /* @__PURE__ */ new Set(["l", "i"]);
var ALLOWED_REMOTE_SUBCOMMANDS = /* @__PURE__ */ new Set(["show", "get-url"]);
function tokenizeArgs(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (quote) {
    throw new Error("Unterminated quote in git query");
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
function validateReadonlyGitArgs(pattern) {
  const rawTokens = tokenizeArgs(pattern.trim());
  const tokens = rawTokens[0] === "git" ? rawTokens.slice(1) : rawTokens;
  if (tokens.length === 0) {
    throw new Error("Empty git query. Example: 'status --short' or 'log -n 5 --oneline'");
  }
  const subcmd = tokens[0];
  if (subcmd.startsWith("-")) {
    throw new Error(
      `Git query must start with a read-only subcommand (got '${subcmd}')`
    );
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcmd)) {
    throw new Error(
      `Git subcommand '${subcmd}' is not allowed in batch_search (read-only only: ${[...READONLY_GIT_SUBCOMMANDS].join(", ")})`
    );
  }
  const rest = tokens.slice(1);
  for (const arg of rest) {
    if (arg === "&&" || arg === "||" || arg === ";" || arg === "|") {
      throw new Error(
        `Shell operator '${arg}' is not supported in git queries; split chained commands into separate batch_search queries`
      );
    }
    const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (FORBIDDEN_GIT_GLOBAL_FLAGS.has(flagName) || arg.startsWith("--output=") || flagName === "--ext" || flagName.startsWith("--ext-") || flagName.startsWith("--textc") || arg.startsWith("-c") && arg.length > 2) {
      throw new Error(`Flag '${arg}' is not allowed in read-only git query`);
    }
  }
  if (subcmd === "branch") {
    let hasListFlag = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!hasListFlag) {
          throw new Error(
            "Positional branch arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_BRANCH_VALUE_FLAGS.has(flagName) && !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) && !ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
        } else if (ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          hasListFlag = true;
        } else if (ALLOWED_BRANCH_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (!ALLOWED_BRANCH_BOOL_FLAGS.has(flagName) && !ALLOWED_BRANCH_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
        }
        if (flagName === "--list" || ALLOWED_BRANCH_COMMIT_OPTIONAL_FLAGS.has(flagName) || ALLOWED_BRANCH_COMMIT_VALUE_FLAGS.has(flagName)) {
          hasListFlag = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (!ALLOWED_BRANCH_SHORT_CHARS.has(ch)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git branch query`);
          }
          if (ch === "l") hasListFlag = true;
        }
      } else if (!hasListFlag) {
        throw new Error(
          `Positional branch argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "tag") {
    let allowsPositionals = false;
    let expectValue = false;
    let expectNonFlagCommit = false;
    for (const arg of rest) {
      if (expectValue) {
        expectValue = false;
        continue;
      }
      if (expectNonFlagCommit) {
        expectNonFlagCommit = false;
        if (arg.startsWith("-")) {
          throw new Error(
            `Expected commit ref after commit filter flag (got '${arg}')`
          );
        }
        continue;
      }
      if (arg === "--") {
        if (!allowsPositionals) {
          throw new Error(
            "Positional tag arguments are only allowed with --list in read-only mode"
          );
        }
        break;
      }
      if (arg.startsWith("--")) {
        const eqIdx = arg.indexOf("=");
        const flagName = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
        if (eqIdx !== -1) {
          if (!ALLOWED_TAG_VALUE_FLAGS.has(flagName) && !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName) && !ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
            throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
          }
        } else if (ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName)) {
          expectNonFlagCommit = true;
          allowsPositionals = true;
        } else if (ALLOWED_TAG_VALUE_FLAGS.has(flagName)) {
          expectValue = true;
        } else if (!ALLOWED_TAG_BOOL_FLAGS.has(flagName) && !ALLOWED_TAG_EQ_ONLY_OPTIONAL_FLAGS.has(flagName)) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
        }
        if (flagName === "--list" || ALLOWED_TAG_COMMIT_OPTIONAL_FLAGS.has(flagName) || ALLOWED_TAG_COMMIT_VALUE_FLAGS.has(flagName)) {
          allowsPositionals = true;
        }
      } else if (arg.startsWith("-") && arg.length > 1) {
        if (/^-n\d*$/.test(arg)) {
          allowsPositionals = true;
        } else {
          for (const ch of arg.slice(1)) {
            if (!ALLOWED_TAG_SHORT_CHARS.has(ch)) {
              throw new Error(`Flag '${arg}' is not allowed in read-only git tag query`);
            }
            if (ch === "l") allowsPositionals = true;
          }
        }
      } else if (!allowsPositionals) {
        throw new Error(
          `Positional tag argument '${arg}' is only allowed with --list in read-only mode`
        );
      }
    }
  } else if (subcmd === "remote") {
    let remoteSubcmd = null;
    for (const arg of rest) {
      if (!remoteSubcmd) {
        if (arg === "-v" || arg === "--verbose") continue;
        if (arg.startsWith("-")) {
          throw new Error(`Flag '${arg}' is not allowed in read-only git remote query`);
        }
        if (!ALLOWED_REMOTE_SUBCOMMANDS.has(arg)) {
          throw new Error(`Mutating git remote subcommand '${arg}' is not allowed`);
        }
        remoteSubcmd = arg;
      } else if (arg.startsWith("-")) {
        const okFlag = remoteSubcmd === "show" && arg === "-n" || remoteSubcmd === "get-url" && (arg === "--push" || arg === "--all");
        if (!okFlag) {
          throw new Error(
            `Flag '${arg}' is not allowed for read-only git remote ${remoteSubcmd}`
          );
        }
      } else if (arg.includes("://") || arg.includes(":") || arg.includes("/") || arg.includes("\\")) {
        throw new Error(
          `Remote target '${arg}' must be a configured remote name, not a URL or path`
        );
      }
    }
  }
  return ["--no-pager", subcmd, ...rest];
}
var FILE_TYPE_GLOBS = {
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  typescript: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  js: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  javascript: ["*.js", "*.jsx", "*.mjs", "*.cjs"],
  py: ["*.py", "*.pyi"],
  python: ["*.py", "*.pyi"],
  go: ["*.go"],
  gd: ["*.gd"],
  gdscript: ["*.gd"],
  rust: ["*.rs"],
  rs: ["*.rs"],
  java: ["*.java"],
  kt: ["*.kt", "*.kts"],
  kotlin: ["*.kt", "*.kts"],
  c: ["*.c", "*.h"],
  cpp: ["*.cc", "*.cpp", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  cs: ["*.cs"],
  csharp: ["*.cs"],
  swift: ["*.swift"],
  rb: ["*.rb"],
  ruby: ["*.rb"],
  php: ["*.php"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  html: ["*.html", "*.htm"],
  vue: ["*.vue"],
  svelte: ["*.svelte"],
  md: ["*.md", "*.mdx", "*.markdown"],
  markdown: ["*.md", "*.mdx", "*.markdown"],
  json: ["*.json", "*.jsonc"],
  yaml: ["*.yml", "*.yaml"],
  yml: ["*.yml", "*.yaml"],
  toml: ["*.toml"],
  xml: ["*.xml"],
  sql: ["*.sql"],
  sh: ["*.sh", "*.bash", "*.zsh"],
  shell: ["*.sh", "*.bash", "*.zsh"]
};
function resolveFileTypeGlobs(fileType) {
  if (fileType === void 0) return null;
  if (typeof fileType !== "string") throw new Error("fileType must be a string");
  const key = fileType.trim().toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const mapped = FILE_TYPE_GLOBS[key];
  if (Object.hasOwn(FILE_TYPE_GLOBS, key)) return mapped;
  if (/^[a-z0-9]+$/i.test(key)) return [`*.${key}`];
  throw new Error(`Unsupported fileType '${fileType}'`);
}
function fileTypeMatcher(fileType) {
  const matchers = (resolveFileTypeGlobs(fileType) ?? []).map(globToRegExp);
  return (file) => matchers.length === 0 || matchers.some((matcher) => matcher.test(path4.basename(file)));
}
async function runTextOrRegexWithRg(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const typeGlobs = resolveFileTypeGlobs(query.fileType);
  const matchesType = fileTypeMatcher(query.fileType);
  const isFileTarget = (await fs3.stat(searchRoot)).isFile();
  if (typeGlobs && !matchesType(searchRoot) && isFileTarget) {
    return { files: [], totalMatches: 0, truncated: false };
  }
  const perFileCap = isFileTarget ? maxResults : Math.min(maxResults, 50);
  const args = ["--no-messages", "--max-filesize", "2M"];
  if (summary || typeGlobs || query.multiline) args.push("--no-config");
  if (query.multiline) args.push("--multiline", "--multiline-dotall", "--crlf");
  if (query.outputMode === "count") {
    args.push(query.multiline ? "--count-matches" : "--count", "--with-filename", "--null");
  } else if (query.outputMode === "files_with_matches") {
    args.push("--files-with-matches", "--null");
  } else {
    args.push("--json");
  }
  if (typeGlobs) {
    for (const glob of typeGlobs) args.push("--type-add", `agyfilter:${glob}`);
    args.push("--type", "agyfilter");
  }
  if (query.type === "text") {
    args.push("--fixed-strings");
  }
  if (query.caseSensitive === false) {
    args.push("--ignore-case");
  }
  if (!summary && contextLines > 0) {
    args.push("-C", String(contextLines));
  }
  if (query.glob) {
    args.push(`--glob=${query.glob}`);
  }
  const normRoot = toPosixPath(searchRoot);
  for (const dir of [
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    "coverage",
    "__pycache__",
    ".venv",
    ".next"
  ]) {
    if (!normRoot.split("/").includes(dir)) {
      args.push(`--glob=!**/${dir}/**`);
    }
  }
  if (!summary && !query.multiline) args.push("--max-count", String(perFileCap + 1));
  args.push("--", query.pattern, searchRoot);
  const res = await execBinaryAsync("rg", args, {
    cwd: baseCwd,
    timeoutMs: 15e3,
    maxOutputBytes: 2 * 1024 * 1024
  });
  if (res.error) {
    throw new Error(`rg spawn error: ${res.error}`);
  }
  if (res.exitCode === 2) {
    throw new Error(res.stderr.trim() || `rg failed for pattern: ${query.pattern}`);
  }
  if (summary) {
    const files2 = [];
    const out = res.stdout;
    let pos = 0;
    while (pos < out.length) {
      const nul = out.indexOf("\0", pos);
      if (nul === -1) break;
      const rawFile = out.slice(pos, nul);
      let count = 0;
      if (query.outputMode === "count") {
        let nl = out.indexOf("\n", nul + 1);
        if (nl === -1) nl = out.length;
        const rawCount = out.slice(nul + 1, nl).trim();
        count = Number(rawCount);
        pos = nl + 1;
      } else {
        pos = nul + 1;
      }
      if (!rawFile || !matchesType(rawFile)) continue;
      files2.push({ file: relativeFile(baseCwd, rawFile), lines: [], count: Number.isFinite(count) ? count : 0 });
    }
    files2.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
    return {
      files: files2.slice(0, maxResults),
      totalMatches: 0,
      truncated: files2.length > maxResults || res.truncated || res.timedOut || res.exitCode === null
    };
  }
  const byFile = /* @__PURE__ */ new Map();
  const matchCountByFile = /* @__PURE__ */ new Map();
  let totalMatches = 0;
  let truncated = false;
  let pendingBeforeContext = [];
  let lastKeptMatchFile = "";
  let lastKeptMatchLine = -1;
  const upsertLine = (relFile, entry) => {
    let lineMap = byFile.get(relFile);
    if (!lineMap) {
      lineMap = /* @__PURE__ */ new Map();
      byFile.set(relFile, lineMap);
    }
    const existing = lineMap.get(entry.lineNumber);
    if (!existing || entry.isMatch) {
      lineMap.set(entry.lineNumber, {
        lineNumber: entry.lineNumber,
        text: entry.text,
        isMatch: entry.isMatch || Boolean(existing?.isMatch)
      });
    }
  };
  for (const rawLine of res.stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (ev.type === "begin" || ev.type === "end") {
      pendingBeforeContext = [];
      lastKeptMatchFile = "";
      lastKeptMatchLine = -1;
      continue;
    }
    if (ev.type !== "match" && ev.type !== "context") continue;
    const rawFile = ev.data?.path?.text ?? (ev.data?.path?.bytes ? Buffer.from(ev.data.path.bytes, "base64").toString("utf8") : void 0);
    const lineNumber = ev.data?.line_number;
    const rawText = ev.data?.lines?.text ?? (ev.data?.lines?.bytes ? Buffer.from(ev.data.lines.bytes, "base64").toString("utf8") : "");
    const lineText = rawText.replace(/\r?\n$/, "");
    if (!rawFile || !matchesType(rawFile) || typeof lineNumber !== "number") continue;
    const absFile = path4.isAbsolute(rawFile) ? rawFile : path4.resolve(baseCwd, rawFile);
    const relFile = toPosixPath(path4.relative(baseCwd, absFile)) || path4.basename(absFile);
    if (ev.type === "context") {
      if (lastKeptMatchFile === relFile && lastKeptMatchLine !== -1 && lineNumber > lastKeptMatchLine && lineNumber <= lastKeptMatchLine + contextLines) {
        upsertLine(relFile, { lineNumber, text: lineText, isMatch: false });
      } else if (totalMatches < maxResults && (query.multiline || (matchCountByFile.get(relFile) ?? 0) < perFileCap)) {
        pendingBeforeContext.push({ relFile, lineNumber, text: lineText });
      }
      continue;
    }
    const fileHits = matchCountByFile.get(relFile) ?? 0;
    if (totalMatches >= maxResults || !query.multiline && fileHits >= perFileCap) {
      truncated = true;
      pendingBeforeContext = [];
      continue;
    }
    for (const ctx of pendingBeforeContext) {
      if (ctx.relFile === relFile) {
        upsertLine(ctx.relFile, {
          lineNumber: ctx.lineNumber,
          text: ctx.text,
          isMatch: false
        });
      }
    }
    pendingBeforeContext = [];
    const segments = query.multiline ? lineText.split(/\r?\n/) : [lineText];
    lastKeptMatchFile = relFile;
    let addedForFile = fileHits;
    for (const [offset, text] of segments.entries()) {
      const line = lineNumber + offset;
      if (byFile.get(relFile)?.get(line)?.isMatch) continue;
      if (totalMatches >= maxResults || !query.multiline && addedForFile >= perFileCap) {
        truncated = true;
        break;
      }
      upsertLine(relFile, { lineNumber: line, text, isMatch: true });
      lastKeptMatchLine = line;
      totalMatches++;
      addedForFile++;
    }
    matchCountByFile.set(relFile, addedForFile);
  }
  const files = [...byFile.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, lineMap]) => ({
    file,
    lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
  }));
  return {
    files,
    totalMatches,
    truncated: truncated || res.truncated || res.timedOut || res.exitCode === null
  };
}
function* multilineMatches(content, regex) {
  let previousEnd = -1;
  for (const match of content.matchAll(regex)) {
    const start = match.index;
    if (start === content.length && (content.length === 0 || content.endsWith("\n"))) break;
    if (match[0] === "") {
      if (start === previousEnd || content[start - 1] === "\r" && content[start] === "\n") continue;
    }
    previousEnd = start + match[0].length;
    yield match;
  }
}
function multilineMatchLines(content, regex, limit) {
  const indices = [];
  let line = 0;
  let nextBreak = content.indexOf("\n");
  for (const match of multilineMatches(content, regex)) {
    const start = match.index;
    const end = start + Math.max(0, match[0].length - 1);
    while (nextBreak !== -1 && nextBreak < start) {
      line++;
      nextBreak = content.indexOf("\n", nextBreak + 1);
    }
    while (true) {
      if (indices.at(-1) !== line) indices.push(line);
      if (indices.length >= limit) return indices;
      if (nextBreak === -1 || nextBreak >= end) break;
      line++;
      nextBreak = content.indexOf("\n", nextBreak + 1);
    }
  }
  return indices;
}
async function runTextOrRegexWithNode(query, searchRoot, baseCwd) {
  const maxResults = clampInt(query.maxResults ?? 40, 1, 200);
  const contextLines = clampInt(query.contextLines ?? 0, 0, 5);
  const flags = (query.caseSensitive === false ? "i" : "") + (query.multiline ? "gmsu" : "");
  let regex;
  if (query.type === "regex") {
    try {
      regex = new RegExp(query.pattern, flags);
    } catch (err) {
      if (flags.includes("u")) {
        try {
          regex = new RegExp(query.pattern, flags.replace("u", ""));
        } catch {
          throw new Error(
            `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        throw new Error(
          `Invalid regex '${query.pattern}': ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  } else {
    const escaped = query.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(escaped, flags);
  }
  const summary = query.outputMode === "count" || query.outputMode === "files_with_matches";
  const matchesType = fileTypeMatcher(query.fileType);
  let discoveryTruncated = false;
  const globRegex = query.glob ? globToRegExp(query.glob) : null;
  const globMatchesFile = (relPosix) => {
    if (!matchesType(relPosix)) return false;
    if (!globRegex) return true;
    if (globRegex.test(relPosix)) return true;
    if (!query.glob.includes("/")) {
      const base = relPosix.split("/").pop() ?? relPosix;
      return globRegex.test(base);
    }
    return false;
  };
  const stat = await fs3.stat(searchRoot);
  const perFileCap = stat.isFile() ? maxResults : Math.min(maxResults, 50);
  let targetFiles;
  if (stat.isFile()) {
    const relPosix = toPosixPath(path4.relative(baseCwd, searchRoot)) || path4.basename(searchRoot);
    targetFiles = globMatchesFile(relPosix) ? [searchRoot] : [];
  } else {
    const includeHidden = Boolean(
      query.glob && (query.glob.startsWith(".") || query.glob.includes("/."))
    );
    const walked = await walkFiles(searchRoot, {
      maxFiles: 8e3,
      includeHidden,
      fileFilter: globMatchesFile
    });
    discoveryTruncated = walked.truncated;
    targetFiles = walked.files.map((rel) => path4.join(searchRoot, rel));
    if (summary) {
      targetFiles.sort((a, b) => {
        const ra = relativeFile(baseCwd, a);
        const rb = relativeFile(baseCwd, b);
        return ra < rb ? -1 : ra > rb ? 1 : 0;
      });
    }
  }
  const files = [];
  let totalMatches = 0;
  let truncated = false;
  const buildFileMatches = (relFile, allLines, keptIndices) => {
    const lineMap = /* @__PURE__ */ new Map();
    for (const mIdx of keptIndices) {
      const from = Math.max(0, mIdx - contextLines);
      const to = Math.min(allLines.length - 1, mIdx + contextLines);
      for (let j = from; j <= to; j++) {
        const ln = j + 1;
        const prev = lineMap.get(ln);
        lineMap.set(ln, {
          lineNumber: ln,
          text: allLines[j],
          isMatch: j === mIdx || Boolean(prev?.isMatch)
        });
      }
    }
    return {
      file: relFile,
      lines: [...lineMap.values()].sort((a, b) => a.lineNumber - b.lineNumber)
    };
  };
  const batchSize = 16;
  let anyFileTruncated = false;
  for (let i = 0; i < targetFiles.length && !truncated; i += batchSize) {
    const batch = targetFiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (absFile) => {
        try {
          const st = await fs3.stat(absFile);
          if (st.size > 2 * 1024 * 1024) return null;
          const buf = await fs3.readFile(absFile);
          if (isLikelyBinary(buf)) return null;
          const content = buf.toString("utf8");
          const lines = content.split(/\r?\n/);
          if (lines.length > 0 && lines.at(-1) === "") lines.pop();
          const relFile = relativeFile(baseCwd, absFile);
          let matchedIndices = [];
          let count = 0;
          let fileTruncated = false;
          if (query.multiline && summary) {
            for (const _match of multilineMatches(content, regex)) {
              count++;
              if (query.outputMode === "files_with_matches") break;
            }
          } else if (query.multiline) {
            matchedIndices = multilineMatchLines(content, regex, maxResults + 1);
            count = matchedIndices.length;
          } else {
            for (let idx = 0; idx < lines.length; idx++) {
              if (regex.test(lines[idx])) {
                if (!summary && matchedIndices.length >= perFileCap) {
                  fileTruncated = true;
                  break;
                }
                matchedIndices.push(idx);
                if (query.outputMode === "files_with_matches") break;
              }
            }
            count = matchedIndices.length;
          }
          return count ? { relFile, lines, matchedIndices, count, fileTruncated } : null;
        } catch {
          return null;
        }
      })
    );
    for (const item of results) {
      if (!item) continue;
      if (summary) {
        if (files.length === maxResults) {
          truncated = true;
          break;
        }
        files.push({ file: item.relFile, lines: [], count: item.count });
        continue;
      }
      if (item.fileTruncated) {
        anyFileTruncated = true;
      }
      if (totalMatches + item.matchedIndices.length > maxResults) {
        const remaining = maxResults - totalMatches;
        if (remaining > 0) {
          const kept = item.matchedIndices.slice(0, remaining);
          files.push(buildFileMatches(item.relFile, item.lines, kept));
          totalMatches += kept.length;
        }
        truncated = true;
        break;
      }
      files.push(buildFileMatches(item.relFile, item.lines, item.matchedIndices));
      totalMatches += item.matchedIndices.length;
    }
  }
  return {
    files,
    totalMatches,
    truncated: truncated || anyFileTruncated || (summary || query.multiline === true) && discoveryTruncated
  };
}
function buildGlobFallbackPlan(pattern) {
  if (!pattern.includes("{") && pattern.includes("|")) {
    const terms = pattern.split("|").map((part) => part.trim()).filter(Boolean);
    if (terms.length >= 2) {
      const termMatchers = terms.map((term) => {
        const hasGlobMeta = /[*?[\]{}]/.test(term);
        if (hasGlobMeta) {
          try {
            const re = globToRegExp(term);
            const matchBase = !term.includes("/");
            return (relPosix, base) => re.test(relPosix) || matchBase && re.test(base);
          } catch {
          }
        }
        const needle = term.toLowerCase();
        return (relPosix) => relPosix.toLowerCase().includes(needle);
      });
      const allBare = terms.every((t) => !/[*?[\]{}/]/.test(t));
      const label = allBare ? `**/*{${terms.join(",")}}*` : `{${terms.join(",")}}`;
      return {
        match: (relPosix, base) => termMatchers.some((fn) => fn(relPosix, base)),
        matchedNote: `[note: exact glob matched 0 files; auto-expanded regex '|' to "${label}" (glob uses * and {a,b}, not |)]`,
        emptyMessage: "(no files matched; hint: glob uses * and {a,b}, not regex |)"
      };
    }
  }
  if (/^[A-Za-z0-9_-]+$/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return {
      match: (relPosix) => relPosix.toLowerCase().includes(needle),
      matchedNote: `[note: exact glob "${pattern}" matched 0 files; showing case-insensitive path matches for "*${pattern}*"]`,
      emptyMessage: "(no files matched)"
    };
  }
  return null;
}
async function formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, sortBy, notePrefix) {
  const relPrefix = toPosixPath(path4.relative(baseCwd, searchRoot));
  const sortedFiles = [...walked.files].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (sortBy === "mtime") {
    const mtimes = /* @__PURE__ */ new Map();
    for (let i = 0; i < sortedFiles.length; i += 32) {
      await Promise.all(sortedFiles.slice(i, i + 32).map(async (file) => {
        const stat = await fs3.lstat(path4.join(searchRoot, file)).catch(() => void 0);
        mtimes.set(file, stat?.mtimeMs ?? -Infinity);
      }));
    }
    sortedFiles.sort((a, b) => mtimes.get(b) - mtimes.get(a) || (a < b ? -1 : a > b ? 1 : 0));
  }
  const items = sortedFiles.slice(0, maxResults).map((f) => {
    if (!relPrefix || relPrefix === ".") return f;
    return `${relPrefix}/${f}`;
  });
  const truncated = walked.truncated || sortedFiles.length > maxResults;
  const header = notePrefix ? `${notePrefix}
` : "";
  if (!truncated) {
    return `${header}${items.join("\n")}`;
  }
  const omitted = sortedFiles.slice(maxResults);
  const dirCounts = /* @__PURE__ */ new Map();
  for (const f of omitted) {
    const slash = f.indexOf("/");
    const bucket = slash === -1 ? "(root)" : `${f.slice(0, slash)}/`;
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1);
  }
  const topDirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, 6).map(([dir, cnt]) => `${dir} (${cnt})`);
  const totalLabel = walked.truncated ? `${walked.files.length}+` : String(walked.files.length);
  const dirSummary = topDirs.length > 0 ? `; omitted dirs: ${topDirs.join(", ")}` : "";
  const suffix = `
... [truncated at ${maxResults} of ${totalLabel} files${dirSummary}]`;
  return `${header}${items.join("\n")}${suffix}`;
}
async function runGlobQuery(query, searchRoot, baseCwd, isFileTarget) {
  const maxResults = clampInt(query.maxResults ?? 80, 1, 300);
  const pattern = query.pattern.trim() || "**/*";
  const matcher = globToRegExp(pattern);
  const matchBasename = !pattern.includes("/");
  const includeHidden = pattern.startsWith(".") || pattern.includes("/.");
  if (isFileTarget) {
    const rel = toPosixPath(path4.relative(baseCwd, searchRoot)) || path4.basename(searchRoot);
    const base = path4.basename(searchRoot);
    const matched = matcher.test(rel) || matchBasename && matcher.test(base);
    if (matched) return rel;
    const fallback2 = buildGlobFallbackPlan(pattern);
    if (fallback2) {
      return fallback2.match(rel, base) ? `${fallback2.matchedNote}
${rel}` : fallback2.emptyMessage;
    }
    return "(no files matched)";
  }
  const scanLimit = Math.max(maxResults + 1, 2e3);
  const walked = await walkFiles(searchRoot, {
    maxFiles: scanLimit,
    includeHidden,
    fileFilter: (relPosix) => {
      if (matcher.test(relPosix)) return true;
      if (matchBasename) {
        const base = relPosix.split("/").pop() ?? relPosix;
        return matcher.test(base);
      }
      return false;
    }
  });
  if (walked.files.length > 0) {
    return formatGlobWalkResult(walked, searchRoot, baseCwd, maxResults, query.sortBy);
  }
  const fallback = buildGlobFallbackPlan(pattern);
  if (fallback) {
    const fallbackWalked = await walkFiles(searchRoot, {
      maxFiles: scanLimit,
      includeHidden,
      fileFilter: (relPosix) => {
        const base = relPosix.split("/").pop() ?? relPosix;
        return fallback.match(relPosix, base);
      }
    });
    if (fallbackWalked.files.length > 0) {
      return formatGlobWalkResult(
        fallbackWalked,
        searchRoot,
        baseCwd,
        maxResults,
        query.sortBy,
        fallback.matchedNote
      );
    }
    return fallback.emptyMessage;
  }
  return "(no files matched)";
}
function relativeFile(baseCwd, file) {
  return toPosixPath(path4.relative(baseCwd, path4.resolve(baseCwd, file))) || path4.basename(file);
}
async function runFuzzyQuery(query, searchRoot, baseCwd, isFileTarget) {
  const pattern = query.pattern.trim();
  if (!pattern) throw new Error("Fuzzy pattern must not be blank");
  const matchesType = fileTypeMatcher(query.fileType);
  const maxResults = clampInt(query.maxResults ?? 30, 1, 200);
  const walked = isFileTarget ? { files: [searchRoot], truncated: false } : await walkFiles(searchRoot, { maxFiles: 8e3, fileFilter: matchesType });
  const candidates = walked.files.filter(matchesType).map((file) => relativeFile(baseCwd, path4.resolve(searchRoot, file)));
  const { matches, totalMatched } = rankFuzzyPaths(pattern, candidates, maxResults);
  const body = matches.map((match) => match.path).join("\n") || "(no files matched)";
  const footer = walked.truncated || totalMatched > maxResults ? `
... [truncated; showing ${matches.length} files]` : "";
  return body + footer;
}
var SHORTLOG_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--group",
  "--format",
  "--since",
  "--after",
  "--until",
  "--before",
  "--author",
  "--committer",
  "--grep",
  "--max-count",
  "--skip"
]);
var SHORTLOG_REV_SELECTOR_FLAGS = /* @__PURE__ */ new Set([
  "--all",
  "--branches",
  "--tags",
  "--remotes",
  "--glob",
  "--stdin"
]);
function hardenGitExecArgs(validatedArgs) {
  const subcmd = validatedArgs[1];
  const rest = validatedArgs.slice(2);
  let subArgs = rest;
  if (subcmd === "diff" || subcmd === "log" || subcmd === "show") {
    subArgs = ["--no-ext-diff", "--no-textconv", ...rest];
  } else if (subcmd === "blame") {
    subArgs = ["--no-textconv", ...rest];
  } else if (subcmd === "remote") {
    const remoteSubIdx = rest.findIndex((a) => !a.startsWith("-"));
    if (remoteSubIdx !== -1 && rest[remoteSubIdx] === "show" && !rest.includes("-n")) {
      subArgs = [...rest.slice(0, remoteSubIdx + 1), "-n", ...rest.slice(remoteSubIdx + 1)];
    }
  } else if (subcmd === "shortlog") {
    let hasRev = false;
    let expectVal = false;
    let dashDashIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (expectVal) {
        expectVal = false;
        continue;
      }
      if (a === "--") {
        dashDashIdx = i;
        break;
      }
      if (a.startsWith("-")) {
        const flagName = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
        if (SHORTLOG_REV_SELECTOR_FLAGS.has(flagName)) {
          hasRev = true;
        } else if (!a.includes("=") && SHORTLOG_VALUE_FLAGS.has(flagName)) {
          expectVal = true;
        }
        continue;
      }
      hasRev = true;
    }
    if (!hasRev) {
      subArgs = dashDashIdx === -1 ? [...rest, "HEAD"] : [...rest.slice(0, dashDashIdx), "HEAD", ...rest.slice(dashDashIdx)];
    }
    subArgs = ["--no-ext-diff", "--no-textconv", ...subArgs];
  }
  return [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "diff.external=",
    "-c",
    "gpg.program=false",
    "-c",
    "gpg.openpgp.program=false",
    "-c",
    "gpg.ssh.program=false",
    "-c",
    "gpg.x509.program=false",
    "--no-pager",
    ...subcmd ? [subcmd, ...subArgs] : subArgs
  ];
}
async function runGitQuery(query, searchRoot) {
  const gitArgs = validateReadonlyGitArgs(query.pattern);
  const execArgs = hardenGitExecArgs(gitArgs);
  const res = await execBinaryAsync("git", execArgs, {
    cwd: searchRoot,
    timeoutMs: 1e4,
    maxOutputBytes: 512 * 1024
  });
  if (res.error) {
    throw new Error(`git execution error: ${res.error}`);
  }
  if (res.timedOut) {
    throw new Error("git query timed out");
  }
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(msg || `git exited with code ${res.exitCode}`);
  }
  const out = res.stdout.trimEnd();
  return out || "(empty output)";
}
function formatFileMatches(files, totalMatches, truncated) {
  if (files.length === 0) {
    return "(no matches)";
  }
  const blocks = [];
  for (const fm of files) {
    const lines = fm.lines.map((l) => {
      const sep = l.isMatch ? ":" : "-";
      const text = l.text.length > 240 ? `${sliceSafeChars(l.text, 240)}...` : l.text;
      return `  ${l.lineNumber}${sep} ${text}`;
    });
    blocks.push(`${fm.file}
${lines.join("\n")}`);
  }
  const footer = truncated ? `
... [truncated at ${totalMatches} matches]` : "";
  return `${blocks.join("\n")}${footer}`;
}
async function executeSingleQuery(query, index, baseCwd, useRg) {
  const header = `## Query ${index + 1} [${query.type}] ${query.pattern}${query.path ? ` (in ${query.path})` : ""}`;
  try {
    if (!query.pattern || typeof query.pattern !== "string") {
      throw new Error("Query 'pattern' must be a non-empty string");
    }
    if (query.multiline !== void 0 && typeof query.multiline !== "boolean") {
      throw new Error("multiline must be a boolean");
    }
    if (query.outputMode !== void 0 && !["content", "files_with_matches", "count"].includes(query.outputMode)) {
      throw new Error("Invalid outputMode");
    }
    if (query.sortBy !== void 0 && !["path", "mtime"].includes(query.sortBy)) {
      throw new Error("Invalid sortBy");
    }
    const searchRoot = query.path ? resolvePath(query.path, baseCwd) : baseCwd;
    let targetStat;
    try {
      targetStat = await fs3.stat(searchRoot);
    } catch {
      throw new Error(`Path does not exist: ${query.path || baseCwd}`);
    }
    if (query.type === "git") {
      const gitCwd = targetStat.isFile() ? path4.dirname(searchRoot) : searchRoot;
      const out = await runGitQuery(query, gitCwd);
      return `${header}
${out}`;
    }
    if (query.type === "glob") {
      const out = await runGlobQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return `${header}
${out}`;
    }
    if (query.type === "fuzzy") {
      const out = await runFuzzyQuery(query, searchRoot, baseCwd, targetStat.isFile());
      return `${header}
${out}`;
    }
    if (query.type === "text" || query.type === "regex") {
      let res;
      if (useRg) {
        try {
          res = await runTextOrRegexWithRg(query, searchRoot, baseCwd);
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("rg spawn error:")) {
            res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
          } else {
            throw err;
          }
        }
      } else {
        res = await runTextOrRegexWithNode(query, searchRoot, baseCwd);
      }
      if (query.outputMode === "count" || query.outputMode === "files_with_matches") {
        const body = res.files.map(({ file, count }) => query.outputMode === "count" ? `${file}: ${count} ${query.multiline ? "matches" : "matching lines"}` : file).join("\n") || "(no matches)";
        const footer = res.truncated ? `
... [truncated; showing ${res.files.length} files]` : "";
        return `${header}
${body}${footer}`;
      }
      return `${header}
${formatFileMatches(res.files, res.totalMatches, res.truncated)}`;
    }
    throw new Error(`Unsupported query type: ${String(query.type)}`);
  } catch (err) {
    return `${header}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function runBatchSearch(input, options = {}) {
  const parsedQueries = parseMaybeJsonArray(input?.queries);
  if (!parsedQueries.ok) {
    if (parsedQueries.kind === "wrong_type" && (typeof input?.queries === "boolean" || input?.queries === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "batch_search",
          items: [{ label: "queries", value: input.queries, expected: "an array of query objects" }],
          fallbackAdvice: "split into smaller queries or use a single compound read-only run_command."
        }),
        isError: true
      };
    }
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  const rawQueries = parsedQueries.value;
  if (rawQueries.length === 0) {
    return {
      text: "Error: 'queries' must be a non-empty array of search queries.",
      isError: true
    };
  }
  if (rawQueries.length > 20) {
    return {
      text: "Error: 'queries' supports at most 20 queries per call.",
      isError: true
    };
  }
  const corruptedQueries = [];
  for (let i = 0; i < rawQueries.length; i++) {
    if (!isPlainObject(rawQueries[i])) {
      corruptedQueries.push({
        label: `queries[${i}]`,
        value: rawQueries[i],
        expected: "a query object ({ type, pattern, ... })"
      });
    }
  }
  if (corruptedQueries.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "batch_search",
        items: corruptedQueries,
        fallbackAdvice: "split into smaller queries or use a single compound read-only run_command."
      }),
      isError: true
    };
  }
  const queries = rawQueries;
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs3.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const maxChars = clampInt(input.maxChars ?? 8500, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const needsTextSearch = queries.some(
    (q) => q.type === "text" || q.type === "regex"
  );
  const useRg = needsTextSearch && !options.forceNodeFallback && await isRipgrepAvailable();
  const sections = await Promise.all(
    queries.map((q, idx) => executeSingleQuery(q, idx, baseCwd, useRg))
  );
  return {
    text: fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n"),
    isError: false
  };
}
function clampInt(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

// src/tools/read-slices.ts
import path5 from "node:path";
function isRegexStartContext(line, slashIdx) {
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j < 0) return true;
  const prev = line[j];
  if ("=(,:![&|?{};~+-*%^<>".includes(prev)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(line[k])) k--;
  const word = line.slice(k + 1, j + 1);
  return word === "return" || word === "case" || word === "throw" || word === "in" || word === "of" || word === "typeof" || word === "void" || word === "delete" || word === "new";
}
function isJsxSelfClosingSlash(line, slashIdx) {
  if (line[slashIdx + 1] !== ">") return false;
  let j = slashIdx - 1;
  while (j >= 0 && /\s/.test(line[j])) j--;
  if (j >= 0 && line[j] !== "}") return false;
  return line[slashIdx + 2] !== "/";
}
function scanBracesOnLine(line, state, lang, ignoreBracesInParensBeforeOpen = false, alreadySeenOpen = false) {
  let open = 0;
  let close = 0;
  let openParen = 0;
  let closeParen = 0;
  let parenDepth = state.parenDepth ?? 0;
  let seenOpen = alreadySeenOpen;
  let inSingle = false;
  let inDouble = false;
  let inRegex = false;
  let inRegexClass = false;
  let escape = false;
  let lastCodeChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (inRegex) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === "[") {
        inRegexClass = true;
      } else if (ch === "]") {
        inRegexClass = false;
      } else if (ch === "/" && !inRegexClass) {
        inRegex = false;
        lastCodeChar = "/";
      }
      continue;
    }
    if (state.inBacktick) {
      if (ch === "\\" && lang !== "go") {
        escape = true;
      } else if (ch === "`") {
        state.inBacktick = false;
        lastCodeChar = "`";
      } else if (lang === "js" && ch === "$" && next === "{") {
        state.inBacktick = false;
        state.templateExprStack.push(0);
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "\\") escape = true;
      else if (ch === "'") {
        inSingle = false;
        lastCodeChar = "'";
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escape = true;
      else if (ch === '"') {
        inDouble = false;
        lastCodeChar = '"';
      }
      continue;
    }
    if (lang === "shell" && ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) {
      break;
    }
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "/") break;
    if ((lang === "js" || lang === "c" || lang === "go" || lang === "rust") && ch === "/" && next === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (lang === "js" && ch === "/" && next !== "/" && next !== "*" && !isJsxSelfClosingSlash(line, i) && line[i - 1] !== "<" && isRegexStartContext(line, i)) {
      inRegex = true;
      inRegexClass = false;
      continue;
    }
    if (ch === "'" && lang !== "json") {
      if (lang === "rust") {
        if (next === "\\" || line[i + 2] === "'") {
          inSingle = true;
        }
        continue;
      }
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`" && (lang === "js" || lang === "c" || lang === "go")) {
      state.inBacktick = true;
      continue;
    }
    if (ch === "{") {
      if (state.templateExprStack.length > 0) {
        state.templateExprStack[state.templateExprStack.length - 1] += 1;
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        open++;
        seenOpen = true;
      }
      lastCodeChar = "{";
    } else if (ch === "}") {
      if (state.templateExprStack.length > 0) {
        const top = state.templateExprStack[state.templateExprStack.length - 1];
        if (top === 0) {
          state.templateExprStack.pop();
          state.inBacktick = true;
        } else {
          state.templateExprStack[state.templateExprStack.length - 1] = top - 1;
        }
      } else if (!(ignoreBracesInParensBeforeOpen && !seenOpen && parenDepth > 0)) {
        close++;
      }
      lastCodeChar = "}";
    } else if (ch === "(") {
      openParen++;
      parenDepth++;
      lastCodeChar = "(";
    } else if (ch === ")") {
      closeParen++;
      parenDepth = Math.max(0, parenDepth - 1);
      lastCodeChar = ")";
    } else if (!/\s/.test(ch)) {
      lastCodeChar = ch;
    }
  }
  state.parenDepth = parenDepth;
  return {
    open,
    close,
    openParen,
    closeParen,
    endsWithSemi: lastCodeChar === ";",
    lastCodeChar
  };
}
function findBraceBlockEnd(lines, startIdx, lang = "c") {
  let depth = 0;
  let seenOpen = false;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const maxScan = Math.min(lines.length, startIdx + 2e3);
  for (let i = startIdx; i < maxScan; i++) {
    const { open, close, endsWithSemi, lastCodeChar } = scanBracesOnLine(
      lines[i],
      state,
      lang,
      lang === "js" || lang === "go",
      seenOpen
    );
    if (open > 0) seenOpen = true;
    depth += open - close;
    if (seenOpen && depth <= 0) {
      if (lang === "js" && lastCodeChar === ">" && i <= startIdx + 12) {
        seenOpen = false;
        depth = 0;
        continue;
      }
      return i + 1;
    }
    if (!seenOpen && (state.parenDepth ?? 0) <= 0 && endsWithSemi) {
      return i + 1;
    }
    if (!seenOpen && i > startIdx + 40) {
      return startIdx + 1;
    }
  }
  return seenOpen ? Math.min(lines.length, maxScan) : startIdx + 1;
}
function findTypeAliasEnd(lines, startIdx) {
  const firstLine = lines[startIdx] ?? "";
  const eqIdx = firstLine.indexOf("=");
  const rhs = eqIdx >= 0 ? firstLine.slice(eqIdx + 1) : firstLine;
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  const firstScan = scanBracesOnLine(rhs, state, "js");
  if (firstScan.open > firstScan.close) {
    return findBraceBlockEnd(lines, startIdx, "js");
  }
  if (firstScan.endsWithSemi && firstScan.openParen <= firstScan.closeParen) {
    return startIdx + 1;
  }
  let endIdx = startIdx;
  let parenBal = firstScan.openParen - firstScan.closeParen;
  let prevLast = firstScan.lastCodeChar;
  const maxScan = Math.min(lines.length - 1, startIdx + 40);
  while (endIdx < maxScan) {
    const nextLine = lines[endIdx + 1] ?? "";
    const nextTrim = nextLine.trim();
    if (!nextTrim) break;
    const isContinuation = parenBal > 0 || prevLast === "=" || prevLast === "|" || prevLast === "&" || prevLast === "?" || prevLast === ":" || /^[ \t]+(?:[|&?:]|\w+\s*\?*:)/.test(nextLine);
    if (!isContinuation) break;
    endIdx++;
    const scan = scanBracesOnLine(nextLine, state, "js");
    if (scan.open > scan.close) {
      return findBraceBlockEnd(lines, endIdx, "js");
    }
    parenBal += scan.openParen - scan.closeParen;
    prevLast = scan.lastCodeChar;
    if (scan.endsWithSemi && parenBal <= 0) break;
  }
  return endIdx + 1;
}
function findParenCallEnd(lines, startIdx) {
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false,
    parenDepth: 0
  };
  let seenParen = false;
  const maxScan = Math.min(lines.length, startIdx + 400);
  for (let i = startIdx; i < maxScan; i++) {
    const { openParen } = scanBracesOnLine(lines[i], state, "js");
    if (openParen > 0) seenParen = true;
    if (seenParen && (state.parenDepth ?? 0) <= 0) {
      return i + 1;
    }
  }
  return startIdx + 1;
}
function hasArrowOrBraceWithin(lines, startIdx, maxLookahead = 12) {
  const state = { inBlockComment: false, templateExprStack: [], inBacktick: false };
  let parenDepth = 0;
  let seenParen = false;
  let hasArrow = false;
  const end = Math.min(lines.length, startIdx + maxLookahead);
  for (let i = startIdx; i < end; i++) {
    const line = lines[i];
    const { open, openParen, closeParen, endsWithSemi } = scanBracesOnLine(line, state, "js");
    if (openParen > 0) seenParen = true;
    parenDepth += openParen - closeParen;
    if (line.includes("=>")) hasArrow = true;
    if (open > 0 && (!seenParen || parenDepth <= 0)) {
      return { hasArrow, hasBrace: true };
    }
    if (seenParen && parenDepth <= 0 && endsWithSemi) {
      return { hasArrow, hasBrace: false };
    }
  }
  return { hasArrow, hasBrace: false };
}
function extractTsJsSymbols(lines) {
  const symbols = [];
  const patterns = [
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      kind: "class",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/,
      kind: "interface",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/,
      kind: "type",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
      kind: "enum",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
      kind: "function",
      nameGroup: 1
    },
    {
      re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
      kind: "function",
      nameGroup: 1
    }
  ];
  const multilineArrowStartRe = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;
  const methodHeaderRe = /^([ \t]{1,4})(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
  const controlKeywords = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "try",
    "return",
    "new",
    "throw",
    "await",
    "super",
    "typeof",
    "delete"
  ]);
  const routeRegisterRe = /^[ \t]{1,6}(?:app|router|server|fastify)\.(get|post|put|patch|delete|all|route)\s*(?:<[^>]*>)?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testSuiteRe = /^(?:describe|suite)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  const testCaseRe = /^[ \t]{0,4}(?:it|test)(?:\.(?:only|skip))?\s*\(\s*['"`]([^'"`]+)['"`]/;
  let currentClassEnd = -1;
  let currentClassIndent = -1;
  let currentFnEnd = -1;
  let currentSuiteEnd = -1;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "js");
    if (wasInComment || wasInBacktick) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      continue;
    }
    let matchedTop = false;
    if (!line.startsWith(" ") && !line.startsWith("	")) {
      for (const p of patterns) {
        const m = p.re.exec(line);
        if (m && m[p.nameGroup]) {
          const endLine = p.kind === "type" ? findTypeAliasEnd(lines, i) : findBraceBlockEnd(lines, i, "js");
          symbols.push({
            kind: p.kind,
            name: m[p.nameGroup],
            startLine: i + 1,
            endLine,
            depth: 0
          });
          if (p.kind === "class") {
            currentClassEnd = endLine;
            currentClassIndent = -1;
          } else if (p.kind === "function" && endLine - (i + 1) >= 40) {
            currentFnEnd = endLine;
          }
          matchedTop = true;
          break;
        }
      }
      if (!matchedTop) {
        const ma = multilineArrowStartRe.exec(line);
        if (ma && ma[1]) {
          const { hasArrow } = hasArrowOrBraceWithin(lines, i, 12);
          if (hasArrow) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "function",
              name: ma[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
            if (endLine - (i + 1) >= 40) {
              currentFnEnd = endLine;
            }
            matchedTop = true;
          }
        }
      }
      if (!matchedTop) {
        const ms = testSuiteRe.exec(line);
        if (ms && ms[1]) {
          const endLine = findParenCallEnd(lines, i);
          symbols.push({
            kind: "suite",
            name: ms[1].slice(0, 64),
            startLine: i + 1,
            endLine,
            depth: 0
          });
          currentSuiteEnd = endLine;
          matchedTop = true;
        }
      }
    }
    if (!matchedTop && i + 1 <= currentClassEnd) {
      const mm = methodHeaderRe.exec(line);
      if (mm && mm[1] && mm[2] && !controlKeywords.has(mm[2])) {
        const indentWidth = mm[1].replace(/\t/g, "  ").length;
        if (currentClassIndent === -1) {
          currentClassIndent = indentWidth;
        }
        if (indentWidth === currentClassIndent) {
          const { hasBrace } = hasArrowOrBraceWithin(lines, i, 10);
          if (hasBrace) {
            const endLine = findBraceBlockEnd(lines, i, "js");
            symbols.push({
              kind: "method",
              name: mm[2],
              startLine: i + 1,
              endLine,
              depth: 1
            });
          }
        }
      }
    } else if (!matchedTop && i + 1 <= currentFnEnd) {
      const mr = routeRegisterRe.exec(line);
      if (mr && mr[1] && mr[2]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "route",
          name: `${mr[1].toUpperCase()} ${mr[2]}`,
          startLine: i + 1,
          endLine,
          depth: 1
        });
      }
    } else if (!matchedTop) {
      const mt = testCaseRe.exec(line);
      if (mt && mt[1]) {
        const endLine = findParenCallEnd(lines, i);
        symbols.push({
          kind: "test",
          name: mt[1].slice(0, 64),
          startLine: i + 1,
          endLine,
          depth: i + 1 <= currentSuiteEnd ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractPythonSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
  const inTripleString = new Array(lines.length).fill(false);
  const openParens = new Array(lines.length).fill(0);
  const closeParens = new Array(lines.length).fill(0);
  let activeQuote = null;
  for (let i = 0; i < lines.length; i++) {
    inTripleString[i] = activeQuote !== null;
    const line = lines[i];
    let j = 0;
    let op = 0;
    let cp = 0;
    while (j < line.length) {
      if (activeQuote) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeQuote, j)) {
          activeQuote = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        if (line[j] === "#") break;
        if (line.startsWith('"""', j)) {
          activeQuote = '"""';
          j += 3;
          continue;
        }
        if (line.startsWith("'''", j)) {
          activeQuote = "'''";
          j += 3;
          continue;
        }
        if (line[j] === '"' || line[j] === "'") {
          const q = line[j];
          j++;
          while (j < line.length && line[j] !== q) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          j++;
          continue;
        }
        if (line[j] === "(") op++;
        else if (line[j] === ")") cp++;
        j++;
      }
    }
    openParens[i] = op;
    closeParens[i] = cp;
  }
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (inTripleString[i]) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "    ").length;
    const kind = m[2] === "class" ? "class" : indent > 0 ? "method" : "function";
    raw.push({ indent, kind, name: m[3], startIdx: i });
  }
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    let headerEndIdx = item.startIdx;
    let parenDepth = openParens[item.startIdx] - closeParens[item.startIdx];
    const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
    while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
      headerEndIdx++;
      parenDepth += openParens[headerEndIdx] - closeParens[headerEndIdx];
    }
    if (parenDepth > 0) headerEndIdx = item.startIdx;
    let endIdx = lines.length - 1;
    for (let j = headerEndIdx + 1; j < lines.length; j++) {
      if (inTripleString[j]) continue;
      const l = lines[j];
      const trimmed = l.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
      if (curIndent <= item.indent) {
        endIdx = j - 1;
        break;
      }
    }
    while (endIdx > headerEndIdx && !lines[endIdx].trim()) {
      endIdx--;
    }
    symbols.push({
      kind: item.kind,
      name: item.name,
      startLine: item.startIdx + 1,
      endLine: Math.max(item.startIdx + 1, endIdx + 1),
      depth: item.indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function stripLeadingGdAnnotations(text) {
  let rest = text;
  while (rest.startsWith("@")) {
    const m = /^@[A-Za-z_]\w*/.exec(rest);
    if (!m) break;
    let idx = m[0].length;
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    if (rest[idx] === "(") {
      let depth = 0;
      let quote = null;
      while (idx < rest.length) {
        const ch = rest[idx];
        if (quote) {
          if (ch === "\\") {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
        } else {
          if (ch === '"' || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") {
            depth--;
            if (depth === 0) {
              idx++;
              break;
            }
          }
        }
        idx++;
      }
    }
    while (idx < rest.length && (rest[idx] === " " || rest[idx] === "	")) idx++;
    rest = rest.slice(idx);
  }
  return rest;
}
function extractGdScriptSymbols(rawLines) {
  const lines = rawLines.map((l, idx) => {
    const clean = l.endsWith("\r") ? l.slice(0, -1) : l;
    return idx === 0 ? clean.replace(/^\uFEFF/, "") : clean;
  });
  const info = new Array(lines.length);
  let activeTriple = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsInTriple = activeTriple !== null;
    let openBrace = 0;
    let closeBrace = 0;
    let openParen = 0;
    let closeParen = 0;
    let hasCode = startsInTriple;
    let j = 0;
    while (j < line.length) {
      if (activeTriple) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line.startsWith(activeTriple, j)) {
          activeTriple = null;
          j += 3;
          continue;
        }
        j++;
      } else {
        const ch = line[j];
        if (ch === "#") break;
        if (line.startsWith('"""', j) || line.startsWith("'''", j)) {
          activeTriple = line.startsWith('"""', j) ? '"""' : "'''";
          hasCode = true;
          j += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          hasCode = true;
          j++;
          while (j < line.length && line[j] !== ch) {
            if (line[j] === "\\") j += 2;
            else j++;
          }
          if (j < line.length) j++;
          continue;
        }
        if (ch !== " " && ch !== "	") {
          hasCode = true;
          if (ch === "{") openBrace++;
          else if (ch === "}") closeBrace++;
          else if (ch === "(") openParen++;
          else if (ch === ")") closeParen++;
        }
        j++;
      }
    }
    info[i] = {
      startsInTriple,
      openBrace,
      closeBrace,
      openParen,
      closeParen,
      hasCode
    };
  }
  const raw = [];
  const classNameRe = /^class_name\s+([A-Za-z_]\w*)\b/;
  const classRe = /^class\s+([A-Za-z_]\w*)\b/;
  const funcRe = /^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const signalRe = /^signal\s+([A-Za-z_]\w*)\b/;
  const enumRe = /^enum(?:\s+([A-Za-z_]\w*))?\s*(?:\{|$|#)/;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].startsInTriple) continue;
    const line = lines[i];
    const indentStr = /^[ \t]*/.exec(line)?.[0] ?? "";
    const afterIndent = line.slice(indentStr.length);
    if (!afterIndent || afterIndent.startsWith("#")) continue;
    const rest = stripLeadingGdAnnotations(afterIndent);
    if (!rest || rest.startsWith("#")) continue;
    const indent = indentStr.replace(/\t/g, "    ").length;
    let m = classNameRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class_name", name: m[1], startIdx: i });
      continue;
    }
    m = classRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "class", name: m[1], startIdx: i });
      continue;
    }
    m = funcRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "func", name: m[1], startIdx: i });
      continue;
    }
    m = signalRe.exec(rest);
    if (m && m[1]) {
      raw.push({ indent, rawKind: "signal", name: m[1], startIdx: i });
      continue;
    }
    m = enumRe.exec(rest);
    if (m) {
      if (!m[1] && info[i].openBrace === 0) {
        let nextCodeIdx = i + 1;
        while (nextCodeIdx < lines.length && !info[nextCodeIdx].hasCode) {
          nextCodeIdx++;
        }
        if (nextCodeIdx >= lines.length || info[nextCodeIdx].openBrace === 0) {
          continue;
        }
      }
      raw.push({
        indent,
        rawKind: "enum",
        name: m[1] ?? "<anonymous>",
        startIdx: i
      });
    }
  }
  const symbols = [];
  const classStack = [];
  for (const item of raw) {
    let endIdx = item.startIdx;
    if (item.rawKind === "class_name") {
      endIdx = item.startIdx;
    } else if (item.rawKind === "signal") {
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxSigScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && endIdx < maxSigScan) {
        endIdx++;
        parenDepth += info[endIdx].openParen - info[endIdx].closeParen;
      }
      if (parenDepth > 0) endIdx = item.startIdx;
    } else if (item.rawKind === "enum") {
      let braceDepth = 0;
      let seenOpen = false;
      const maxEnumScan = Math.min(lines.length - 1, item.startIdx + 500);
      for (let k = item.startIdx; k <= maxEnumScan; k++) {
        const li = info[k];
        if (li.openBrace > 0) seenOpen = true;
        braceDepth += li.openBrace - li.closeBrace;
        if (seenOpen && braceDepth <= 0) {
          endIdx = k;
          break;
        }
        if (!seenOpen && k > item.startIdx && li.hasCode && li.openBrace === 0) {
          break;
        }
      }
      if (seenOpen && braceDepth > 0) {
        endIdx = maxEnumScan;
      }
    } else {
      let headerEndIdx = item.startIdx;
      let parenDepth = info[item.startIdx].openParen - info[item.startIdx].closeParen;
      const maxHeaderScan = Math.min(lines.length - 1, item.startIdx + 40);
      while (parenDepth > 0 && headerEndIdx < maxHeaderScan) {
        headerEndIdx++;
        parenDepth += info[headerEndIdx].openParen - info[headerEndIdx].closeParen;
      }
      if (parenDepth > 0) headerEndIdx = item.startIdx;
      endIdx = lines.length - 1;
      for (let j = headerEndIdx + 1; j < lines.length; j++) {
        if (info[j].startsInTriple) continue;
        const l = lines[j];
        const trimmed = l.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const curIndent = (/^[ \t]*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
        if (curIndent <= item.indent) {
          endIdx = j - 1;
          break;
        }
      }
      while (endIdx > headerEndIdx) {
        if (info[endIdx].startsInTriple) break;
        const endLineStr = lines[endIdx];
        const endTrimmed = endLineStr.trim();
        if (!endTrimmed) {
          endIdx--;
          continue;
        }
        if (endTrimmed.startsWith("#")) {
          const commentIndent = (/^[ \t]*/.exec(endLineStr)?.[0] ?? "").replace(
            /\t/g,
            "    "
          ).length;
          if (commentIndent <= item.indent) {
            endIdx--;
            continue;
          }
        }
        break;
      }
    }
    const startLine = item.startIdx + 1;
    const endLine = Math.max(startLine, endIdx + 1);
    while (classStack.length > 0 && (classStack[classStack.length - 1].endLine < startLine || classStack[classStack.length - 1].indent >= item.indent)) {
      classStack.pop();
    }
    const depth = classStack.length > 0 ? classStack.length : item.indent > 0 ? Math.max(1, Math.floor(item.indent / 4)) : 0;
    const kind = item.rawKind === "func" ? item.indent > 0 ? "method" : "function" : item.rawKind;
    symbols.push({
      kind,
      name: item.name,
      startLine,
      endLine,
      depth
    });
    if (item.rawKind === "class") {
      classStack.push({ indent: item.indent, endLine });
    }
  }
  return symbols;
}
function extractGoSymbols(lines) {
  const symbols = [];
  const funcRe = /^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z_]\w*)/;
  const typeRe = /^type\s+([A-Za-z_]\w*(?:\[[^\]]*\])?)\s+(struct|interface)\b/;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    const wasInBacktick = commentState.inBacktick;
    scanBracesOnLine(line, commentState, "go");
    if (wasInComment || wasInBacktick) continue;
    const fm = funcRe.exec(line);
    if (fm && fm[2]) {
      const recv = fm[1]?.trim();
      const name = recv ? `(${recv}) ${fm[2]}` : fm[2];
      symbols.push({
        kind: recv ? "method" : "function",
        name,
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0
      });
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[1] && tm[2]) {
      symbols.push({
        kind: tm[2],
        name: tm[1],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "go"),
        depth: 0
      });
    }
  }
  return symbols;
}
function extractRustSymbols(lines) {
  const symbols = [];
  const re = /^([ \t]*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|trait|impl|mod)(?:\s+|\s*(?=<))([A-Za-z_<][\w:<>,+'&\s]*?)(?:\s*[\({;]|$)/;
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "rust");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      continue;
    }
    const m = re.exec(line);
    if (!m || !m[2] || !m[3]) continue;
    const indent = m[1].length;
    if (indent > 4) continue;
    symbols.push({
      kind: m[2],
      name: m[3].trim(),
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "rust"),
      depth: indent > 0 ? 1 : 0
    });
  }
  return symbols;
}
function extractCLikeSymbols(lines) {
  const symbols = [];
  const typeRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open|export|partial)\s+)*(class|interface|enum|struct|record|protocol|namespace)\s+([A-Za-z_]\w*)/;
  const kwFuncRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|override|virtual|inline|async|suspend|open|mutating)\s+)*(?:fun|func)\s+([A-Za-z_]\w*)/;
  const cMethodRe = /^([ \t]{0,4})(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|inline|constexpr|extern|async|synchronized|native|unsigned|signed|const)\s+)*(?:[A-Za-z_~][\w:<>,\[\]\s*&]*?\s+)([A-Za-z_~][\w:]*)\s*\([^;]*$/;
  const excludedNames = /* @__PURE__ */ new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "else",
    "return",
    "sizeof",
    "alignof",
    "decltype",
    "new",
    "delete",
    "throw",
    "typedef",
    "using",
    "case"
  ]);
  const commentState = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInComment = commentState.inBlockComment;
    scanBracesOnLine(line, commentState, "c");
    if (wasInComment) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
      continue;
    }
    const tm = typeRe.exec(line);
    if (tm && tm[2] && tm[3]) {
      const indented = (tm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: tm[2],
        name: tm[3],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const fm = kwFuncRe.exec(line);
    if (fm && fm[2]) {
      const indented = (fm[1]?.length ?? 0) > 0;
      symbols.push({
        kind: indented ? "method" : "function",
        name: fm[2],
        startLine: i + 1,
        endLine: findBraceBlockEnd(lines, i, "c"),
        depth: indented ? 1 : 0
      });
      continue;
    }
    const cm = cMethodRe.exec(line);
    if (cm && cm[2] && !excludedNames.has(cm[2]) && !trimmed.includes("=")) {
      const { hasBrace } = hasArrowOrBraceWithin(lines, i, 8);
      if (hasBrace) {
        const indented = (cm[1]?.length ?? 0) > 0;
        symbols.push({
          kind: indented ? "method" : "function",
          name: cm[2],
          startLine: i + 1,
          endLine: findBraceBlockEnd(lines, i, "c"),
          depth: indented ? 1 : 0
        });
      }
    }
  }
  return symbols;
}
function extractShellSymbols(lines) {
  const symbols = [];
  const re = /^(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    symbols.push({
      kind: "function",
      name,
      startLine: i + 1,
      endLine: findBraceBlockEnd(lines, i, "shell"),
      depth: 0
    });
  }
  return symbols;
}
function extractMarkdownSymbols(lines) {
  const raw = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (m && m[1] && m[2]) {
      raw.push({ level: m[1].length, name: m[2], startLine: i + 1 });
    }
  }
  return raw.map((item, idx) => {
    let endLine = lines.length;
    for (let j = idx + 1; j < raw.length; j++) {
      if (raw[j].level <= item.level) {
        endLine = raw[j].startLine - 1;
        break;
      }
    }
    return {
      kind: `h${item.level}`,
      name: item.name,
      startLine: item.startLine,
      endLine: Math.max(item.startLine, endLine),
      depth: item.level - 1
    };
  });
}
function extractJsonYamlSymbols(lines, isJson) {
  const symbols = [];
  if (isJson) {
    let keyIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /^([ \t]+)"([^"]+)"\s*:/.exec(lines[i]);
      if (m && m[1] && m[2]) {
        if (keyIndent === null) {
          keyIndent = m[1];
        }
        if (m[1] === keyIndent) {
          symbols.push({
            kind: "key",
            name: m[2],
            startLine: i + 1,
            endLine: i + 1,
            depth: 0
          });
        }
      }
    }
    for (let idx = 0; idx < symbols.length; idx++) {
      const cur = symbols[idx];
      const nextStart = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length - 1;
      let endLine = Math.max(cur.startLine, nextStart);
      while (endLine > cur.startLine && /^\s*[}\]]?,?\s*$/.test(lines[endLine - 1] ?? "") && idx === symbols.length - 1) {
        endLine--;
      }
      cur.endLine = endLine;
    }
    return symbols;
  }
  const re = /^([A-Za-z0-9_.-]+)\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && m[1]) {
      symbols.push({
        kind: "key",
        name: m[1],
        startLine: i + 1,
        endLine: i + 1,
        depth: 0
      });
    }
  }
  for (let idx = 0; idx < symbols.length; idx++) {
    const cur = symbols[idx];
    let endLine = idx + 1 < symbols.length ? symbols[idx + 1].startLine - 1 : lines.length;
    while (endLine > cur.startLine && !(lines[endLine - 1] ?? "").trim()) {
      endLine--;
    }
    cur.endLine = Math.max(cur.startLine, endLine);
  }
  return symbols;
}
function extractCssSymbols(lines, compactOnly = false) {
  const symbols = [];
  const state = {
    inBlockComment: false,
    templateExprStack: [],
    inBacktick: false
  };
  let braceDepth = 0;
  const atRuleRe = /^@(layer|media|keyframes|supports|container|font-face|theme)\b([^{;]*)/i;
  const tokenBlockRe = /^(:root\b|html(?:\[[^\]]+\]|\.[A-Za-z_-][\w-]*)?(?=\s|[,{])|\[data-theme[^\]]*\]|body\b)[^{;]*\{/;
  const sectionCommentRe = /^\/\*\s*[=\-*#]*\s*([^*/=][^*/]{1,70}?)\s*[=\-*#]*\s*\*\/$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const wasInComment = state.inBlockComment;
    if (!wasInComment && braceDepth === 0 && trimmed) {
      const cm = sectionCommentRe.exec(trimmed);
      if (cm && cm[1] && /[A-Za-z0-9\u4e00-\u9fff]/.test(cm[1])) {
        symbols.push({
          kind: "section",
          name: cm[1].trim().slice(0, 64),
          startLine: i + 1,
          endLine: i + 1,
          depth: 0
        });
      } else {
        const am = atRuleRe.exec(trimmed);
        if (am && am[1]) {
          const endLine = trimmed.includes("{") ? findBraceBlockEnd(lines, i, "c") : i + 1;
          const rest = (am[2] ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
          symbols.push({
            kind: `@${am[1].toLowerCase()}`,
            name: rest || `@${am[1].toLowerCase()}`,
            startLine: i + 1,
            endLine,
            depth: 0
          });
        } else {
          const tm = tokenBlockRe.exec(trimmed);
          if (tm && tm[1]) {
            const endLine = findBraceBlockEnd(lines, i, "c");
            const header = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
            symbols.push({
              kind: "tokens",
              name: header || tm[1],
              startLine: i + 1,
              endLine,
              depth: 0
            });
          }
        }
      }
    }
    const { open, close } = scanBracesOnLine(line, state, "c");
    braceDepth = Math.max(0, braceDepth + open - close);
  }
  if (!compactOnly && symbols.length < 10) {
    const fallbackState = {
      inBlockComment: false,
      templateExprStack: [],
      inBacktick: false
    };
    let d = 0;
    let lastAddedLine = -999;
    const seen = new Set(symbols.map((s) => s.startLine));
    for (let i = 0; i < lines.length && symbols.length < 40; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const wasInComment = fallbackState.inBlockComment;
      if (!wasInComment && d === 0 && !seen.has(i + 1) && i - lastAddedLine >= 10 && /^[.#\[a-zA-Z*:]/.test(trimmed) && trimmed.includes("{") && !trimmed.startsWith("@")) {
        const sel = trimmed.slice(0, trimmed.indexOf("{")).trim().replace(/\s+/g, " ").slice(0, 60);
        if (sel) {
          const endLine = findBraceBlockEnd(lines, i, "c");
          symbols.push({
            kind: "rule",
            name: sel,
            startLine: i + 1,
            endLine,
            depth: 0
          });
          lastAddedLine = i;
        }
      }
      const { open, close } = scanBracesOnLine(line, fallbackState, "c");
      d = Math.max(0, d + open - close);
    }
    symbols.sort((a, b) => a.startLine - b.startLine);
  }
  return symbols;
}
function extractSfcSymbols(lines) {
  const symbols = [];
  const blockOpenRe = /^<(script|template|style)\b([^>]*)>/i;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = blockOpenRe.exec(line.trim());
    if (!m || !m[1] || line.startsWith("  ") || line.startsWith("	")) {
      i++;
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = (m[2] ?? "").trim();
    const startIdx = i;
    let endIdx = i;
    if (tag === "template") {
      let depth = 0;
      const openTemplateRe = /<template\b[^>]*>/gi;
      const closeTemplateRe = /<\/template\s*>/gi;
      for (let j = i; j < lines.length; j++) {
        const ln = lines[j];
        const opens = ln.match(openTemplateRe)?.length ?? 0;
        const closes = ln.match(closeTemplateRe)?.length ?? 0;
        depth += opens - closes;
        if (depth <= 0) {
          endIdx = j;
          break;
        }
        endIdx = j;
      }
    } else {
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      for (let j = i; j < lines.length; j++) {
        endIdx = j;
        if (j > i && closeRe.test(lines[j])) break;
        if (j === i && closeRe.test(lines[j].slice(m[0].length))) break;
      }
    }
    const headerLabel = attrs ? `<${tag} ${attrs.slice(0, 40)}>` : `<${tag}>`;
    symbols.push({
      kind: tag,
      name: headerLabel,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      depth: 0
    });
    const innerStart = startIdx + 1;
    const innerLines = lines.slice(innerStart, endIdx);
    if (tag === "script" && innerLines.length > 0) {
      const innerSyms = extractTsJsSymbols(innerLines);
      for (const s of innerSyms) {
        symbols.push({
          kind: s.kind,
          name: s.name,
          startLine: s.startLine + innerStart,
          endLine: s.endLine + innerStart,
          depth: s.depth + 1
        });
      }
    } else if (tag === "template" && innerLines.length >= 30) {
      let landmarks = 0;
      const commentLandmarkRe = /^<!--\s*[=\-*#]*\s*([^-][^>]{2,60}?)\s*[=\-*#]*\s*-->$/;
      const semanticTagRe = /^<(header|nav|main|aside|section|footer|dialog|form|[A-Z][A-Za-z0-9]*(?:Modal|Drawer|Dialog|Panel))\b([^>]*)>/;
      for (let k = 0; k < innerLines.length && landmarks < 14; k++) {
        const raw = innerLines[k];
        const indent = raw.length - raw.trimStart().length;
        if (indent > 8) continue;
        const trimmed = raw.trim();
        const cm = commentLandmarkRe.exec(trimmed);
        if (cm && cm[1]) {
          symbols.push({
            kind: "section",
            name: cm[1].trim(),
            startLine: innerStart + k + 1,
            endLine: innerStart + k + 1,
            depth: 1
          });
          landmarks++;
          continue;
        }
        const sm = semanticTagRe.exec(trimmed);
        if (sm && sm[1]) {
          const attrStr = sm[2] ?? "";
          const idMatch = /(?:data-testid|id|class)=["']([^"']+)["']/.exec(attrStr);
          const tagDesc = idMatch && idMatch[1] ? `<${sm[1]} ${idMatch[1].slice(0, 36)}>` : `<${sm[1]}>`;
          symbols.push({
            kind: "block",
            name: tagDesc,
            startLine: innerStart + k + 1,
            endLine: innerStart + k + 1,
            depth: 1
          });
          landmarks++;
        }
      }
    } else if (tag === "style" && innerLines.length > 0) {
      const cssSyms = extractCssSymbols(innerLines, true).slice(0, 12);
      for (const s of cssSyms) {
        symbols.push({
          kind: s.kind,
          name: s.name,
          startLine: s.startLine + innerStart,
          endLine: s.endLine + innerStart,
          depth: 1
        });
      }
    }
    i = endIdx + 1;
  }
  return symbols.length > 0 ? symbols : extractTsJsSymbols(lines);
}
function extractSymbolsFromLines(filePath, lines) {
  const ext = path5.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".mts":
    case ".cts":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return extractTsJsSymbols(lines);
    case ".vue":
    case ".svelte":
      return extractSfcSymbols(lines);
    case ".css":
    case ".scss":
    case ".less":
    case ".pcss":
      return extractCssSymbols(lines);
    case ".py":
    case ".pyi":
      return extractPythonSymbols(lines);
    case ".gd":
      return extractGdScriptSymbols(lines);
    case ".go":
      return extractGoSymbols(lines);
    case ".rs":
      return extractRustSymbols(lines);
    case ".java":
    case ".kt":
    case ".kts":
    case ".cs":
    case ".swift":
    case ".c":
    case ".cc":
    case ".cpp":
    case ".h":
    case ".hpp":
      return extractCLikeSymbols(lines);
    case ".sh":
    case ".bash":
    case ".zsh":
      return extractShellSymbols(lines);
    case ".md":
    case ".mdx":
      return extractMarkdownSymbols(lines);
    case ".json":
      return extractJsonYamlSymbols(lines, true);
    case ".yaml":
    case ".yml":
      return extractJsonYamlSymbols(lines, false);
    default:
      return extractTsJsSymbols(lines);
  }
}
var MAX_OUTLINES = 40;
var MAX_SLICE_FILES = 30;
var SLICE_TRUNCATION_TIP = "\n[tip: MCP responses are hard-capped <=8.8KB inline; for >150 lines across files, use parallel read_file(StartLine, EndLine) (46KB/call, 0 remote check)]";
var OUTLINE_BATCH_TIP = "\n[tip: outlining >20 files splits the 8.8KB cap thinly; batch 10-20 files per call for fuller outlines]";
function selectOutlineSymbols(symbols, limit) {
  if (symbols.length <= limit) return symbols;
  const keptIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    if (symbols[i].depth === 0) keptIndices.add(i);
  }
  for (let i = 0; i < symbols.length && keptIndices.size < limit; i++) {
    keptIndices.add(i);
  }
  return [...keptIndices].sort((a, b) => a - b).map((idx) => symbols[idx]);
}
async function runReadSlices(input) {
  const corruptedItems = [];
  let outlines = [];
  if (input?.outlines !== void 0) {
    const parsedOutlines = parseMaybeJsonArray(input.outlines);
    if (!parsedOutlines.ok) {
      corruptedItems.push({
        label: "outlines",
        value: input.outlines,
        expected: "an array of file path strings"
      });
    } else {
      for (let i = 0; i < parsedOutlines.value.length; i++) {
        const item = parsedOutlines.value[i];
        if (typeof item !== "string" || !item.trim()) {
          corruptedItems.push({
            label: `outlines[${i}]`,
            value: item,
            expected: "a non-empty file path string"
          });
        }
      }
      if (corruptedItems.length === 0) {
        outlines = parsedOutlines.value;
      }
    }
  }
  let slices = [];
  if (input?.slices !== void 0) {
    const parsedSlices = parseMaybeJsonArray(input.slices);
    if (!parsedSlices.ok) {
      corruptedItems.push({
        label: "slices",
        value: input.slices,
        expected: "an array of slice objects ({ path, ranges })"
      });
    } else {
      for (let i = 0; i < parsedSlices.value.length; i++) {
        const item = parsedSlices.value[i];
        if (!isPlainObject(item)) {
          corruptedItems.push({
            label: `slices[${i}]`,
            value: item,
            expected: "a slice object ({ path, ranges })"
          });
          continue;
        }
        if (item.ranges !== void 0 && !Array.isArray(item.ranges)) {
          corruptedItems.push({
            label: `slices[${i}].ranges`,
            value: item.ranges,
            expected: "an array of [startLine, endLine] pairs"
          });
        } else if (Array.isArray(item.ranges)) {
          for (let j = 0; j < item.ranges.length; j++) {
            const r = item.ranges[j];
            if (typeof r === "boolean" || r === null) {
              corruptedItems.push({
                label: `slices[${i}].ranges[${j}]`,
                value: r,
                expected: "a [startLine, endLine] pair"
              });
            }
          }
        }
      }
      if (corruptedItems.length === 0) {
        slices = parsedSlices.value;
      }
    }
  }
  if (corruptedItems.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "read_slices",
        items: corruptedItems,
        fallbackAdvice: "immediately fall back to parallel built-in read_file(StartLine, EndLine) calls."
      }),
      isError: true
    };
  }
  if (outlines.length === 0 && slices.length === 0) {
    return {
      text: "Error: provide at least one entry in 'outlines' or 'slices'.",
      isError: true
    };
  }
  if (outlines.length > MAX_OUTLINES || slices.length > MAX_SLICE_FILES) {
    return {
      text: `Error: limits exceeded (max ${MAX_OUTLINES} outlines and ${MAX_SLICE_FILES} slice files per call).`,
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  const rawMaxChars = Number(input.maxChars ?? 8500);
  const maxChars = Number.isFinite(rawMaxChars) ? Math.max(1e3, Math.min(DEFAULT_INLINE_MAX_BYTES, Math.trunc(rawMaxChars))) : 8500;
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const perFileSymbolLimit = outlines.length <= 1 ? 120 : outlines.length <= 4 ? 60 : outlines.length <= 10 ? 30 : outlines.length <= 20 ? 16 : 10;
  const fileCache = /* @__PURE__ */ new Map();
  async function loadLines(absPath) {
    const cached = fileCache.get(absPath);
    if (cached) return cached;
    const data = await readTextFile(absPath);
    const lines = data.content.replace(/\r\n/g, "\n").split("\n");
    const entry = { lines, size: data.size };
    fileCache.set(absPath, entry);
    return entry;
  }
  const sections = [];
  if (outlines.length > 0) {
    const outlineResults = await Promise.all(
      outlines.map(async (rawPath) => {
        const absPath = resolvePath(rawPath, baseCwd);
        const relPath = toPosixPath(path5.relative(baseCwd, absPath)) || path5.basename(absPath);
        try {
          const { lines } = await loadLines(absPath);
          const symbols = extractSymbolsFromLines(absPath, lines);
          if (symbols.length === 0) {
            return `## Outline: ${relPath} (${lines.length} lines)
(no top-level symbols detected)`;
          }
          const picked = selectOutlineSymbols(symbols, perFileSymbolLimit);
          const formatted = picked.map((s) => {
            const indent = "  ".repeat(s.depth);
            const span = s.endLine > s.startLine ? `L${s.startLine}-L${s.endLine}` : `L${s.startLine}`;
            return `${indent}${span} [${s.kind}] ${s.name}`;
          });
          const extra = symbols.length > picked.length ? outlines.length > 10 ? `
... (+${symbols.length - picked.length} more symbols)` : `
... (${symbols.length - picked.length} more symbols omitted; outline this file alone for full list)` : "";
          return `## Outline: ${relPath} (${lines.length} lines)
${formatted.join("\n")}${extra}`;
        } catch (err) {
          return `## Outline: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
    sections.push(...outlineResults);
  }
  if (slices.length > 0) {
    const sliceResults = await Promise.all(
      slices.map(async (req) => {
        if (!req || typeof req.path !== "string" || !req.path.trim()) {
          return "## Slice: (invalid)\nERROR: 'path' must be a non-empty string";
        }
        const absPath = resolvePath(req.path, baseCwd);
        const relPath = toPosixPath(path5.relative(baseCwd, absPath)) || path5.basename(absPath);
        if (!Array.isArray(req.ranges) || req.ranges.length === 0) {
          return `## Slice: ${relPath}
ERROR: 'ranges' must be a non-empty array of [startLine, endLine] pairs`;
        }
        try {
          const { lines } = await loadLines(absPath);
          const totalLines = lines.length;
          const blocks = [];
          for (const range of req.ranges) {
            if (!Array.isArray(range) || range.length < 2) {
              blocks.push("ERROR: each range must be [startLine, endLine]");
              continue;
            }
            const rawStart = Math.trunc(Number(range[0]));
            const rawEnd = Math.trunc(Number(range[1]));
            if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
              blocks.push(`ERROR: invalid range [${String(range[0])}, ${String(range[1])}]`);
              continue;
            }
            const start = Math.max(1, rawStart);
            const end = Math.min(totalLines, rawEnd);
            if (start > totalLines) {
              blocks.push(
                `--- L${rawStart}-L${rawEnd} (out of bounds; file has ${totalLines} lines) ---`
              );
              continue;
            }
            if (end < start) {
              blocks.push(
                `ERROR: startLine (${rawStart}) > endLine (${rawEnd})`
              );
              continue;
            }
            const width = String(end).length;
            const snippet = [`--- L${start}-L${end} (of ${totalLines}) ---`];
            for (let ln = start; ln <= end; ln++) {
              const num = String(ln).padStart(width, " ");
              snippet.push(`${num}: ${lines[ln - 1] ?? ""}`);
            }
            blocks.push(snippet.join("\n"));
          }
          return `## Slice: ${relPath} (${totalLines} lines)
${blocks.join("\n")}`;
        } catch (err) {
          return `## Slice: ${relPath}
ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
      })
    );
    sections.push(...sliceResults);
  }
  const rawJoined = sections.join("\n\n");
  const rawBytes = Buffer.byteLength(rawJoined, "utf8");
  const isOverBudget = rawJoined.length > maxChars || rawBytes > maxBytes;
  const activeTip = isOverBudget && slices.length > 0 ? SLICE_TRUNCATION_TIP : isOverBudget && outlines.length > 20 ? OUTLINE_BATCH_TIP : null;
  if (activeTip && maxChars > activeTip.length + 200) {
    const tipBytes = Buffer.byteLength(activeTip, "utf8");
    const body = fitSectionsToByteBudget(
      sections,
      maxChars - activeTip.length,
      maxBytes - tipBytes,
      "\n\n"
    );
    return {
      text: `${body}${activeTip}`,
      isError: false
    };
  }
  return {
    text: fitSectionsToByteBudget(sections, maxChars, maxBytes, "\n\n"),
    isError: false
  };
}

// src/tools/run-checks.ts
import { promises as fs4 } from "node:fs";
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runWorker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
async function runChecks(input) {
  const parsedCommands = parseMaybeJsonArray(input?.commands);
  if (!parsedCommands.ok) {
    if (parsedCommands.kind === "wrong_type" && (typeof input?.commands === "boolean" || input?.commands === null)) {
      return {
        text: formatCorruptedArrayError({
          header: "Validation failed",
          toolName: "run_checks",
          items: [{ label: "commands", value: input.commands, expected: "an array of command specs" }],
          fallbackAdvice: "immediately fall back to a single compound run_command call."
        }),
        isError: true
      };
    }
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  const rawCommands = parsedCommands.value;
  if (rawCommands.length === 0) {
    return {
      text: "Error: 'commands' must be a non-empty array of check commands.",
      isError: true
    };
  }
  if (rawCommands.length > 12) {
    return {
      text: "Error: 'commands' supports at most 12 commands per call.",
      isError: true
    };
  }
  const corruptedCommands = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    if (typeof raw !== "string" && !isPlainObject(raw)) {
      corruptedCommands.push({
        label: `commands[${i}]`,
        value: raw,
        expected: "a command string or object ({ name?, command, cwd?, timeoutSec? })"
      });
    }
  }
  if (corruptedCommands.length > 0) {
    return {
      text: formatCorruptedArrayError({
        header: "Validation failed",
        toolName: "run_checks",
        items: corruptedCommands,
        fallbackAdvice: "immediately fall back to a single compound run_command call."
      }),
      isError: true
    };
  }
  const baseCwd = resolvePath(input.cwd || process.cwd());
  try {
    const st = await fs4.stat(baseCwd);
    if (!st.isDirectory()) {
      return { text: `Error: cwd is not a directory: ${baseCwd}`, isError: true };
    }
  } catch {
    return { text: `Error: cwd does not exist: ${baseCwd}`, isError: true };
  }
  const concurrency = clampInt2(input.concurrency ?? 4, 1, 8);
  const defaultTimeoutSec = clampInt2(input.timeoutSec ?? 60, 1, 300);
  const outputMode = input.outputMode === "full" ? "full" : "compact";
  const maxChars = clampInt2(input.maxChars ?? 8e3, 500, DEFAULT_INLINE_MAX_BYTES);
  const maxBytes = DEFAULT_INLINE_MAX_BYTES;
  const normalized = [];
  for (let i = 0; i < rawCommands.length; i++) {
    const raw = rawCommands[i];
    const spec = typeof raw === "string" ? { command: raw } : raw;
    if (!spec || typeof spec.command !== "string" || !spec.command.trim()) {
      return {
        text: `Error: commands[${i}] must contain a non-empty 'command' string.`,
        isError: true
      };
    }
    const cmdCwd = spec.cwd ? resolvePath(spec.cwd, baseCwd) : baseCwd;
    if (spec.cwd) {
      try {
        const st = await fs4.stat(cmdCwd);
        if (!st.isDirectory()) {
          return {
            text: `Error: commands[${i}].cwd is not a directory: ${cmdCwd}`,
            isError: true
          };
        }
      } catch {
        return {
          text: `Error: commands[${i}].cwd does not exist: ${cmdCwd}`,
          isError: true
        };
      }
    }
    const cmdTimeoutSec = clampInt2(
      spec.timeoutSec ?? defaultTimeoutSec,
      1,
      300
    );
    normalized.push({
      index: i,
      name: spec.name?.trim() || `check-${i + 1}`,
      command: spec.command.trim(),
      cwd: cmdCwd,
      timeoutMs: cmdTimeoutSec * 1e3
    });
  }
  const wallStart = Date.now();
  const outcomes = await mapWithConcurrency(
    normalized,
    concurrency,
    async (spec) => {
      const result = await runShellCommandAsync(spec.command, {
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs
      });
      const passed = !result.error && !result.timedOut && result.exitCode === 0;
      return { spec, result, passed };
    }
  );
  const wallMs = Date.now() - wallStart;
  const passedCount = outcomes.filter((o) => o.passed).length;
  const failedCount = outcomes.length - passedCount;
  const summaryHeader = failedCount === 0 ? `Checks: ${passedCount}/${outcomes.length} passed (wall: ${wallMs}ms)` : `Checks: ${passedCount}/${outcomes.length} passed, ${failedCount} failed (wall: ${wallMs}ms)`;
  const usableChars = Math.max(200, maxChars - summaryHeader.length - 4);
  const failedBudget = failedCount > 0 ? Math.max(160, Math.floor((usableChars - passedCount * 120) / failedCount)) : 320;
  const fullPerCmdBudget = Math.max(
    160,
    Math.floor(usableChars / outcomes.length)
  );
  const blocks = outcomes.map(({ spec, result, passed }) => {
    const badge = result.error ? "ERROR" : result.timedOut ? "TIMEOUT" : passed ? "PASS" : `FAIL (exit ${result.exitCode ?? "err"})`;
    if (outputMode === "full") {
      const combined = [
        normalizeTerminalOutput(result.stdout),
        normalizeTerminalOutput(result.stderr)
      ].filter(Boolean).join("\n");
      const body2 = result.error ? `spawn error: ${result.error}` : truncateWithNotice(combined || "(no output)", fullPerCmdBudget);
      return `## [${badge}] ${spec.name} (${result.durationMs}ms)
$ ${spec.command}
${body2}`;
    }
    const body = formatCompactCommandOutput({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      error: result.error,
      maxChars: passed ? 300 : failedBudget
    });
    if (passed) {
      return `- [PASS ${result.durationMs}ms] ${spec.name} (\`${spec.command}\`): ${body}`;
    }
    return `## [${badge} ${result.durationMs}ms] ${spec.name}
$ ${spec.command}
${body}`;
  });
  const bodyBudget = Math.max(0, maxChars - summaryHeader.length - 2);
  const bodyByteBudget = maxBytes !== void 0 ? Math.max(0, maxBytes - Buffer.byteLength(summaryHeader, "utf8") - 2) : void 0;
  const fittedBlocks = fitSectionsToByteBudget(
    blocks,
    bodyBudget,
    bodyByteBudget,
    "\n\n"
  );
  let text = truncateWithNotice(
    `${summaryHeader}

${fittedBlocks}`,
    maxChars
  );
  if (maxBytes !== void 0) {
    text = truncateWithByteNotice(text, maxBytes);
  }
  return { text, isError: false };
}
function clampInt2(val, min, max) {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.trunc(val)));
}

// src/mcp-server.ts
var SERVER_VERSION = "0.2.6";
function createAgyFastServer() {
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION
  });
  server.registerTool(
    {
      name: "batch_search",
      description: "Run multiple read-only text/regex searches, file globs, fuzzy path lookups, and read-only git queries (status/diff/log/show/branch) concurrently in one call with bounded output.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace directory (defaults to current working directory)."
          },
          queries: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            description: "List of search/glob/git queries to run concurrently.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["text", "regex", "glob", "fuzzy", "git"]
                },
                pattern: {
                  type: "string",
                  description: "Literal text, regex, fuzzy path query, glob pattern (use * and {a,b}, not regex |), or read-only git subcommand (e.g. 'status --short', 'log -n 5 --oneline')."
                },
                path: {
                  type: "string",
                  description: "Optional subdirectory or file relative to cwd."
                },
                glob: {
                  type: "string",
                  description: "Optional file filter glob for text/regex queries (e.g. '*.ts')."
                },
                multiline: {
                  type: "boolean",
                  description: "Allow text/regex to span lines. In multiline regex, dot matches newlines."
                },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"],
                  description: "Text/regex output (default content). Count reports matching lines per file, or occurrences in multiline mode."
                },
                fileType: {
                  type: "string",
                  description: "Language or extension filter for text, regex, or fuzzy queries (e.g. typescript or ts)."
                },
                sortBy: {
                  type: "string",
                  enum: ["path", "mtime"],
                  description: "Glob order (default path). Use mtime for newest first."
                },
                caseSensitive: {
                  type: "boolean",
                  description: "Case sensitivity for text/regex (default true)."
                },
                contextLines: {
                  type: "integer",
                  minimum: 0,
                  maximum: 5,
                  description: "Context lines around matches (default 0)."
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: 200,
                  description: "Max matches/files for this query (default 40)."
                }
              },
              required: ["type", "pattern"]
            }
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes to avoid disk spills)."
          }
        },
        required: ["queries"]
      }
    },
    (args) => runBatchSearch(args)
  );
  server.registerTool(
    {
      name: "apply_edits",
      description: "Atomically apply multiple non-contiguous hunks across one or more files (all-or-nothing) with optional file creation, deletion, move/rename, empty parent directory pruning, and inline verify command.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Base directory for relative file paths, delete/move scope boundary, and verify command."
          },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "Files to edit, create, delete, or move/rename.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                hunks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      target: { type: "string", description: "Exact text to replace." },
                      replacement: { type: "string", description: "Replacement text." },
                      startLine: {
                        type: "integer",
                        minimum: 1,
                        description: "Optional 1-based start line to narrow matching."
                      },
                      endLine: {
                        type: "integer",
                        minimum: 1,
                        description: "Optional 1-based end line to narrow matching."
                      },
                      replaceAll: {
                        type: "boolean",
                        description: "Replace every occurrence in range (default false)."
                      }
                    },
                    required: ["target", "replacement"]
                  }
                },
                create: {
                  type: "string",
                  description: "Create file with this full content instead of hunks."
                },
                overwrite: {
                  type: "boolean",
                  description: "Allow overwriting an existing target file when using 'create' or 'moveTo'."
                },
                delete: {
                  type: "boolean",
                  description: "Delete the file or symlink at 'path' (strictly inside cwd; mutually exclusive with hunks/create/moveTo; staged via same-filesystem rename for O(1) rollback)."
                },
                moveTo: {
                  type: "string",
                  description: "Move or rename the file at 'path' to this destination path (strictly inside cwd; may be combined with 'hunks' to move and edit in one step)."
                },
                pruneEmptyDirs: {
                  type: "boolean",
                  description: "When deleting or moving a file, recursively remove empty parent directories strictly inside cwd (overrides top-level pruneEmptyDirs)."
                }
              },
              required: ["path"]
            }
          },
          dryRun: {
            type: "boolean",
            description: "Validate all operations without modifying files (default false)."
          },
          bestEffort: {
            type: "boolean",
            description: "When true, apply valid files even if other files fail validation (each file remains atomic; failed files return closest-line snippets and verify is skipped until fixed). Default false (all-or-nothing)."
          },
          pruneEmptyDirs: {
            type: "boolean",
            description: "Batch default for removing empty source parent directories after 'delete' or 'moveTo' operations (strictly inside cwd; default false)."
          },
          verify: {
            type: "string",
            description: "Optional shell command run right after writing (e.g. 'npm run typecheck')."
          },
          verifyTimeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Optional timeout in seconds for the verify command (default 60)."
          },
          maxVerifyChars: {
            type: "integer",
            minimum: 300,
            maximum: 7500,
            description: "Optional character cap for verify output (default 4000; full response hard-capped <= 8800 UTF-8 bytes)."
          }
        },
        required: ["edits"]
      }
    },
    (args) => runApplyEdits(args)
  );
  server.registerTool(
    {
      name: "read_slices",
      description: "Batch-extract symbol/section outlines (TS/JS/Vue/Svelte/CSS/Python/GDScript/Go/Rust/Java/MD/JSON/YAML) across files (prefer 10-20 files/batch, max 40) in one call, plus optional tiny <=120-line slices. For reading >150 lines of known ranges, prefer parallel built-in read_file(StartLine, EndLine) (46KB/call inline, 0 remote check).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
            description: "File paths to extract top-level symbol/section line ranges from (prefer 10-20 per batch for fuller outlines; max 40)."
          },
          slices: {
            type: "array",
            maxItems: 30,
            description: "Optional tiny 1-based inclusive [startLine, endLine] ranges to piggyback (total response hard-capped <= 8800 UTF-8 bytes).",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                ranges: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "array",
                    minItems: 2,
                    maxItems: 2,
                    items: { type: "integer", minimum: 1 }
                  }
                }
              },
              required: ["path", "ranges"]
            }
          },
          maxChars: {
            type: "integer",
            minimum: 1e3,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes to prevent output.txt spills)."
          }
        }
      }
    },
    (args) => runReadSlices(args)
  );
  server.registerTool(
    {
      name: "run_checks",
      description: "Run multiple independent non-interactive shell commands concurrently under one check (build/typecheck/lint/test with outputMode 'compact', or diagnostic/audit scripts with outputMode 'full').",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          commands: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description: "Commands to execute concurrently.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Short label (e.g. 'typecheck')." },
                command: { type: "string", description: "Shell command to run." },
                cwd: { type: "string", description: "Optional working directory override." },
                timeoutSec: { type: "integer", minimum: 1, maximum: 300 }
              },
              required: ["command"]
            }
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description: "Max parallel commands (default 4)."
          },
          timeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Default per-command timeout in seconds (default 60)."
          },
          outputMode: {
            type: "string",
            enum: ["compact", "full"],
            description: "'compact' hides verbose pass logs (default); 'full' preserves stdout for diagnostic/inspection commands."
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Total character cap (default 8000; hard inline UTF-8 cap <= 8800 bytes)."
          }
        },
        required: ["commands"]
      }
    },
    (args) => runChecks(args)
  );
  return server;
}
function main() {
  const server = createAgyFastServer();
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    process.stdout.end(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  server.listen(process.stdin, process.stdout, flushAndExit);
}
main();
export {
  createAgyFastServer
};
