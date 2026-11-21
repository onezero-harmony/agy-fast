import { McpStdioServer } from "./protocol/mcp.js";
import { runApplyEdits, type ApplyEditsInput } from "./tools/apply-edits.js";
import { runBatchSearch, type BatchSearchInput } from "./tools/batch-search.js";
import { runReadSlices, type ReadSlicesInput } from "./tools/read-slices.js";
import { runChecks, type RunChecksInput } from "./tools/run-checks.js";

const SERVER_VERSION = "0.2.6";

export function createAgyFastServer(): McpStdioServer {
  const server = new McpStdioServer({
    name: "agy-fast",
    version: SERVER_VERSION,
  });

  server.registerTool(
    {
      name: "batch_search",
      description:
        "Run multiple read-only text/regex searches, file globs, fuzzy path lookups, and read-only git queries (status/diff/log/show/branch) concurrently in one call with bounded output.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Workspace directory (defaults to current working directory).",
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
                  enum: ["text", "regex", "glob", "fuzzy", "git"],
                },
                pattern: {
                  type: "string",
                  description:
                    "Literal text, regex, fuzzy path query, glob pattern (use * and {a,b}, not regex |), or read-only git subcommand (e.g. 'status --short', 'log -n 5 --oneline').",
                },
                path: {
                  type: "string",
                  description: "Optional subdirectory or file relative to cwd.",
                },
                glob: {
                  type: "string",
                  description: "Optional file filter glob for text/regex queries (e.g. '*.ts').",
                },
                multiline: {
                  type: "boolean",
                  description: "Allow text/regex to span lines. In multiline regex, dot matches newlines.",
                },
                outputMode: {
                  type: "string",
                  enum: ["content", "files_with_matches", "count"],
                  description: "Text/regex output (default content). Count reports matching lines per file, or occurrences in multiline mode.",
                },
                fileType: {
                  type: "string",
                  description: "Language or extension filter for text, regex, or fuzzy queries (e.g. typescript or ts).",
                },
                sortBy: {
                  type: "string",
                  enum: ["path", "mtime"],
                  description: "Glob order (default path). Use mtime for newest first.",
                },
                caseSensitive: {
                  type: "boolean",
                  description: "Case sensitivity for text/regex (default true).",
                },
                contextLines: {
                  type: "integer",
                  minimum: 0,
                  maximum: 5,
                  description: "Context lines around matches (default 0).",
                },
                maxResults: {
                  type: "integer",
                  minimum: 1,
                  maximum: 200,
                  description: "Max matches/files for this query (default 40).",
                },
              },
              required: ["type", "pattern"],
            },
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes to avoid disk spills).",
          },
        },
        required: ["queries"],
      },
    },
    (args) => runBatchSearch(args as unknown as BatchSearchInput),
  );

  server.registerTool(
    {
      name: "apply_edits",
      description:
        "Atomically apply multiple non-contiguous hunks across one or more files (all-or-nothing) with optional file creation, deletion, move/rename, empty parent directory pruning, and inline verify command.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: {
            type: "string",
            description: "Base directory for relative file paths, delete/move scope boundary, and verify command.",
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
                        description: "Optional 1-based start line to narrow matching.",
                      },
                      endLine: {
                        type: "integer",
                        minimum: 1,
                        description: "Optional 1-based end line to narrow matching.",
                      },
                      replaceAll: {
                        type: "boolean",
                        description: "Replace every occurrence in range (default false).",
                      },
                    },
                    required: ["target", "replacement"],
                  },
                },
                create: {
                  type: "string",
                  description: "Create file with this full content instead of hunks.",
                },
                overwrite: {
                  type: "boolean",
                  description: "Allow overwriting an existing target file when using 'create' or 'moveTo'.",
                },
                delete: {
                  type: "boolean",
                  description:
                    "Delete the file or symlink at 'path' (strictly inside cwd; mutually exclusive with hunks/create/moveTo; staged via same-filesystem rename for O(1) rollback).",
                },
                moveTo: {
                  type: "string",
                  description:
                    "Move or rename the file at 'path' to this destination path (strictly inside cwd; may be combined with 'hunks' to move and edit in one step).",
                },
                pruneEmptyDirs: {
                  type: "boolean",
                  description:
                    "When deleting or moving a file, recursively remove empty parent directories strictly inside cwd (overrides top-level pruneEmptyDirs).",
                },
              },
              required: ["path"],
            },
          },
          dryRun: {
            type: "boolean",
            description: "Validate all operations without modifying files (default false).",
          },
          bestEffort: {
            type: "boolean",
            description:
              "When true, apply valid files even if other files fail validation (each file remains atomic; failed files return closest-line snippets and verify is skipped until fixed). Default false (all-or-nothing).",
          },
          pruneEmptyDirs: {
            type: "boolean",
            description:
              "Batch default for removing empty source parent directories after 'delete' or 'moveTo' operations (strictly inside cwd; default false).",
          },
          verify: {
            type: "string",
            description:
              "Optional shell command run right after writing (e.g. 'npm run typecheck').",
          },
          verifyTimeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Optional timeout in seconds for the verify command (default 60).",
          },
          maxVerifyChars: {
            type: "integer",
            minimum: 300,
            maximum: 7500,
            description: "Optional character cap for verify output (default 4000; full response hard-capped <= 8800 UTF-8 bytes).",
          },
        },
        required: ["edits"],
      },
    },
    (args) => runApplyEdits(args as unknown as ApplyEditsInput),
  );

  server.registerTool(
    {
      name: "read_slices",
      description:
        "Batch-extract symbol/section outlines (TS/JS/Vue/Svelte/CSS/Python/GDScript/Go/Rust/Java/MD/JSON/YAML) across files (prefer 10-20 files/batch, max 40) in one call, plus optional tiny <=120-line slices. For reading >150 lines of known ranges, prefer parallel built-in read_file(StartLine, EndLine) (46KB/call inline, 0 remote check).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          outlines: {
            type: "array",
            maxItems: 40,
            items: { type: "string" },
            description: "File paths to extract top-level symbol/section line ranges from (prefer 10-20 per batch for fuller outlines; max 40).",
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
                    items: { type: "integer", minimum: 1 },
                  },
                },
              },
              required: ["path", "ranges"],
            },
          },
          maxChars: {
            type: "integer",
            minimum: 1000,
            maximum: 8800,
            description: "Total character cap (default 8500; hard inline UTF-8 cap <= 8800 bytes to prevent output.txt spills).",
          },
        },
      },
    },
    (args) => runReadSlices(args as unknown as ReadSlicesInput),
  );

  server.registerTool(
    {
      name: "run_checks",
      description:
        "Run multiple independent non-interactive shell commands concurrently under one check (build/typecheck/lint/test with outputMode 'compact', or diagnostic/audit scripts with outputMode 'full').",
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
                timeoutSec: { type: "integer", minimum: 1, maximum: 300 },
              },
              required: ["command"],
            },
          },
          concurrency: {
            type: "integer",
            minimum: 1,
            maximum: 8,
            description: "Max parallel commands (default 4).",
          },
          timeoutSec: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Default per-command timeout in seconds (default 60).",
          },
          outputMode: {
            type: "string",
            enum: ["compact", "full"],
            description: "'compact' hides verbose pass logs (default); 'full' preserves stdout for diagnostic/inspection commands.",
          },
          maxChars: {
            type: "integer",
            minimum: 500,
            maximum: 8800,
            description: "Total character cap (default 8000; hard inline UTF-8 cap <= 8800 bytes).",
          },
        },
        required: ["commands"],
      },
    },
    (args) => runChecks(args as unknown as RunChecksInput),
  );

  return server;
}

function main(): void {
  const server = createAgyFastServer();
  const exitImmediately = () => {
    process.exit(0);
  };
  const flushAndExit = () => {
    // Wait for buffered stdout pipe writes (>64KB) to drain before exiting
    process.stdout.end(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", exitImmediately);
  process.on("SIGTERM", exitImmediately);
  server.listen(process.stdin, process.stdout, flushAndExit);
}

main();
