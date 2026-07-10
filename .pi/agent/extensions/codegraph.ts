// codegraph — wrap codegraph CLI (https://github.com/colbymchenry/codegraph)
// as native pi tools. Each tool shells out to `codegraph <subcmd>` and projects
// the result to a compact, token-lean form for the model (raw JSON kept in
// `details`). Project must be initialized first (`codegraph init`).

import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "./shared/exec";

const CODEGRAPH_BIN = "codegraph";
const MAX_ROWS = 40;
const MAX_TEXT_BYTES = 32 * 1024;

// Probe at extension load: register tools only if the index exists for cwd.
// Agent sees tool → tool works. No "check status first" hedging needed.
// Tradeoff: running `codegraph init -i` mid-session requires pi restart for
// tools to appear.
function isCodegraphInitialized(cwd: string): boolean {
  try {
    const r = spawnSync(CODEGRAPH_BIN, ["status", "-j"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return false;
    const parsed = JSON.parse(r.stdout) as { initialized?: boolean };
    return parsed.initialized === true;
  } catch {
    return false;
  }
}

function truncateText(s: string): string {
  if (s.length <= MAX_TEXT_BYTES) return s;
  return `${s.slice(0, MAX_TEXT_BYTES)}\n\n…[truncated at ${MAX_TEXT_BYTES} bytes]`;
}

// Compact a row list with an "N of M" header and a narrowing hint.
function rowBlock(rows: string[], total: number, hint: string): string {
  if (total === 0) return "0 results";
  const shown = rows.slice(0, MAX_ROWS);
  const head =
    total > shown.length
      ? `Showing ${shown.length} of ${total}${hint ? ` — ${hint}` : ""}`
      : `${total} result${total === 1 ? "" : "s"}`;
  return [head, ...shown].join("\n");
}

type Node = {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
};
const loc = (n: Node) => `${n.filePath}:${n.startLine}`;
const nodeRow = (n: Node) => `${n.name}  ${n.kind}  ${loc(n)}`;

function fmtQuery(
  arr: Array<{ node: Node & { isExported?: boolean } }>,
): string {
  const rows = arr.map(
    (r) => `${nodeRow(r.node)}${r.node.isExported ? "  [exported]" : ""}`,
  );
  return rowBlock(rows, arr.length, "add kind/limit to narrow");
}

function fmtFiles(
  arr: Array<{ path: string; language: string; nodeCount: number }>,
): string {
  const rows = arr.map((f) => `${f.path}  ${f.language}  nodes=${f.nodeCount}`);
  return rowBlock(rows, arr.length, "add filter/pattern to narrow");
}

function fmtEdges(symbol: string, arr: Node[], label: string): string {
  if (!arr.length) return `${symbol}: 0 ${label}`;
  const shown = arr.slice(0, MAX_ROWS).map(nodeRow);
  const head =
    arr.length > shown.length
      ? `${symbol}: ${shown.length} of ${arr.length} ${label} (raise limit for more)`
      : `${symbol}: ${arr.length} ${label}`;
  return [head, ...shown].join("\n");
}

function fmtImpact(j: {
  symbol: string;
  depth: number;
  nodeCount: number;
  edgeCount: number;
  affected: Node[];
}): string {
  const head = `${j.symbol} depth=${j.depth}: ${j.nodeCount} affected, ${j.edgeCount} edges`;
  const shown = j.affected.slice(0, MAX_ROWS).map(nodeRow);
  const note =
    j.affected.length > shown.length
      ? `\n…${j.affected.length - shown.length} more (raise depth/limit)`
      : "";
  return [head, ...shown].join("\n") + note;
}

function fmtAffected(j: {
  changedFiles: string[];
  affectedTests: string[];
  totalDependentsTraversed: number;
}): string {
  const head = `changed: ${j.changedFiles.length} file(s) → ${j.affectedTests.length} affected test(s) (traversed ${j.totalDependentsTraversed})`;
  if (!j.affectedTests.length) return `${head}\n0 tests affected`;
  return [head, ...j.affectedTests.slice(0, MAX_ROWS)].join("\n");
}

async function callCodegraph(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  format?: (json: unknown) => string,
) {
  const { stdout, stderr, code } = await run(CODEGRAPH_BIN, args, signal, cwd);
  if (code !== 0) {
    const msg = stderr.trim() || stdout.trim() || `codegraph exit ${code}`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: undefined,
      error: msg,
    };
  }
  if (format) {
    try {
      const json = JSON.parse(stdout);
      return {
        content: [{ type: "text" as const, text: format(json) }],
        details: json,
      };
    } catch {
      // Fall through to raw text on unexpected shape.
    }
  }
  return {
    content: [{ type: "text" as const, text: truncateText(stdout) }],
    details: undefined,
  };
}

const EDIT_TOOLS = new Set(["edit", "write", "str_replace", "create"]);

export default function (pi: ExtensionAPI) {
  const loadCwd = process.cwd();
  if (!isCodegraphInitialized(loadCwd)) return;

  // Keep the on-disk index fresh. CLI reads hit the graph directly; the
  // file-watcher that auto-syncs runs only under `codegraph serve`, so in
  // pi-only use the graph drifts after edits and returns stale
  // callers/defs/impact. Sync once per turn after any edit. Fire-and-forget
  // so turn-idle isn't delayed; sync only diffs changed files, so it's cheap.
  let editedThisTurn = false;
  pi.on("tool_result", async (event) => {
    if (!event.isError && EDIT_TOOLS.has(event.toolName)) editedThisTurn = true;
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!editedThisTurn) return;
    editedThisTurn = false;
    const child = spawn(CODEGRAPH_BIN, ["sync", "-q"], {
      cwd: ctx.cwd ?? loadCwd,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  });

  pi.registerTool({
    name: "codegraph_context",
    label: "CodeGraph context",
    description:
      'Conceptual cross-file flow ("how does data flow X→Y", multi-file feature trace, what-calls-what chains). NO anchor needed. Returns relevant symbols\' source + call paths in one shot. WRONG tool for literal API/identifier surface ("where is `pi.foo` registered", "every file that calls X", "find duplicate pattern Z") — semantic search drifts on those; use grep or codegraph_search. lsp_* CANNOT replace this — LSP requires an anchor.',
    parameters: Type.Object({
      task: Type.String({
        description:
          "Natural-language description of what you're trying to understand, e.g. 'how authentication middleware processes requests'",
      }),
      maxFiles: Type.Optional(
        Type.Number({ description: "Max files to include source from" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { task: string; maxFiles?: number };
      const args = ["explore", a.task];
      if (a.maxFiles) args.push("--max-files", String(a.maxFiles));
      return callCodegraph(args, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "codegraph_search",
    label: "CodeGraph search",
    description:
      "Find symbol DEFINITIONS by name (kind-filtered). Use when you have a name but no file:line anchor yet. Returns definition sites only — for USES of a known symbol use lsp_references. Beats grep on precision for symbols but MISSES strings, comments, and cross-file duplicate-pattern detection — pair with grep for those.",
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or fragment" }),
      kind: Type.Optional(
        Type.String({
          description:
            "Filter by kind: function, class, method, interface, etc.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 10)" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { query: string; kind?: string; limit?: number };
      const args = ["query", a.query, "-j"];
      if (a.kind) args.push("-k", a.kind);
      if (a.limit) args.push("-l", String(a.limit));
      return callCodegraph(args, ctx.cwd, signal, (j) =>
        fmtQuery(j as Array<{ node: Node & { isExported?: boolean } }>),
      );
    },
  });

  pi.registerTool({
    name: "codegraph_files",
    label: "CodeGraph files",
    description:
      "Project file tree from index with language + symbol-count per file. Use over find/ls for project structure overview.",
    parameters: Type.Object({
      filter: Type.Optional(
        Type.String({ description: "Filter to files under this directory" }),
      ),
      pattern: Type.Optional(
        Type.String({ description: "Glob pattern, e.g. '**/*.ts'" }),
      ),
      maxDepth: Type.Optional(
        Type.Number({ description: "Max directory depth" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { filter?: string; pattern?: string; maxDepth?: number };
      const args = ["files", "-j"];
      if (a.filter) args.push("--filter", a.filter);
      if (a.pattern) args.push("--pattern", a.pattern);
      if (a.maxDepth) args.push("--max-depth", String(a.maxDepth));
      return callCodegraph(args, ctx.cwd, signal, (j) =>
        fmtFiles(
          j as Array<{ path: string; language: string; nodeCount: number }>,
        ),
      );
    },
  });

  pi.registerTool({
    name: "codegraph_callers",
    label: "CodeGraph callers",
    description:
      "Call-graph INBOUND: functions/methods that CALL <symbol>, looked up by name — NO anchor. Returns call edges only, not every reference. Differs from lsp_references, which needs a file:line anchor and returns all uses (reads, types, imports, not just calls). Use when you have a name and want its callers.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name (function/method)" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20)" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { symbol: string; limit?: number };
      const args = ["callers", a.symbol, "-j"];
      if (a.limit) args.push("-l", String(a.limit));
      return callCodegraph(args, ctx.cwd, signal, (j) => {
        const d = j as { symbol: string; callers: Node[] };
        return fmtEdges(d.symbol, d.callers ?? [], "callers");
      });
    },
  });

  pi.registerTool({
    name: "codegraph_callees",
    label: "CodeGraph callees",
    description:
      "Call-graph OUTBOUND: functions/methods that <symbol> CALLS, by name — NO anchor. No lsp_* equivalent exists. Use to see what a function depends on / delegates to without reading its body.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name (function/method)" }),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default 20)" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { symbol: string; limit?: number };
      const args = ["callees", a.symbol, "-j"];
      if (a.limit) args.push("-l", String(a.limit));
      return callCodegraph(args, ctx.cwd, signal, (j) => {
        const d = j as { symbol: string; callees: Node[] };
        return fmtEdges(d.symbol, d.callees ?? [], "callees");
      });
    },
  });

  pi.registerTool({
    name: "codegraph_impact",
    label: "CodeGraph impact",
    description:
      "Transitive blast radius: symbols that break if <symbol> changes (callers-of-callers up to depth). Run BEFORE a rename/refactor to scope breakage. Broader than one-hop codegraph_callers.",
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name" }),
      depth: Type.Optional(
        Type.Number({ description: "Traversal depth (default 2, max 10)" }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { symbol: string; depth?: number };
      const args = ["impact", a.symbol, "-j"];
      if (a.depth) args.push("-d", String(a.depth));
      return callCodegraph(args, ctx.cwd, signal, (j) =>
        fmtImpact(
          j as {
            symbol: string;
            depth: number;
            nodeCount: number;
            edgeCount: number;
            affected: Node[];
          },
        ),
      );
    },
  });

  pi.registerTool({
    name: "codegraph_affected",
    label: "CodeGraph affected tests",
    description:
      "Test selection: given changed source files, returns test files that transitively depend on them. Feed it `git diff --name-only` output to pick which tests to run after an edit instead of the whole suite.",
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        description: "Changed source file paths",
      }),
      depth: Type.Optional(
        Type.Number({ description: "Max traversal depth (default 5)" }),
      ),
      filter: Type.Optional(
        Type.String({
          description: "Glob for test files, e.g. 'e2e/*.spec.ts'",
        }),
      ),
    }),
    async execute(_id, raw, signal, _onUpdate, ctx) {
      const a = raw as { files: string[]; depth?: number; filter?: string };
      if (!a.files?.length) {
        const msg =
          "codegraph_affected: provide at least one changed file path";
        return {
          content: [{ type: "text" as const, text: msg }],
          details: undefined,
          error: msg,
        };
      }
      const args = ["affected", "-j"];
      if (a.depth) args.push("-d", String(a.depth));
      if (a.filter) args.push("-f", a.filter);
      args.push(...a.files);
      return callCodegraph(args, ctx.cwd, signal, (j) =>
        fmtAffected(
          j as {
            changedFiles: string[];
            affectedTests: string[];
            totalDependentsTraversed: number;
          },
        ),
      );
    },
  });
}
