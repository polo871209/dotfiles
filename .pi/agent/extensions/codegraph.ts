// codegraph — wrap codegraph CLI (https://github.com/colbymchenry/codegraph)
// as native pi tools. Each tool shells out to `codegraph <subcmd> -j` and
// returns the JSON. Project must be initialized first (`codegraph init -i`).

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CODEGRAPH_BIN = "codegraph";
const MAX_OUTPUT_BYTES = 64 * 1024;

function runCodegraph(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(CODEGRAPH_BIN, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: any) => (stdout += d.toString()));
    child.stderr.on("data", (d: any) => (stderr += d.toString()));
    child.on("close", (code: any) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
    child.on("error", (err: any) =>
      resolve({ stdout: "", stderr: err.message, code: -1 }),
    );
  });
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return (
    s.slice(0, MAX_OUTPUT_BYTES) +
    `\n\n…[truncated at ${MAX_OUTPUT_BYTES} bytes]`
  );
}

async function callCodegraph(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) {
  const { stdout, stderr, code } = await runCodegraph(args, cwd, signal);
  if (code !== 0) {
    const msg = stderr.trim() || stdout.trim() || `codegraph exit ${code}`;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: undefined,
      error: msg,
    };
  }
  return {
    content: [{ type: "text" as const, text: truncate(stdout) }],
    details: undefined,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "codegraph_status",
    label: "CodeGraph status",
    description:
      "Check codegraph index for cwd. CALL FIRST in any recon session. If `initialized:false`, silently skip all codegraph_* and use lsp_*/grep — do NOT ask the user to init.",
    parameters: Type.Object({}),
    async execute(_id: any, _raw: any, signal: any, _onUpdate: any, ctx: any) {
      return callCodegraph(["status", "-j"], ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "codegraph_context",
    label: "CodeGraph context",
    description:
      'Concept exploration ("how does X work", architecture trace, feature mapping). NO file:line anchor needed. ONE call returns entry-point symbols + related nodes + code snippets. Use when codegraph_status reports initialized. lsp_* CANNOT replace this — LSP requires an anchor.',
    parameters: Type.Object({
      task: Type.String({
        description:
          "Natural-language description of what you're trying to understand, e.g. 'how authentication middleware processes requests'",
      }),
      maxNodes: Type.Optional(
        Type.Number({ description: "Max symbols to include (default 50)" }),
      ),
      maxCode: Type.Optional(
        Type.Number({ description: "Max code blocks (default 10)" }),
      ),
    }),
    async execute(_id: any, raw: any, signal: any, _onUpdate: any, ctx: any) {
      const a = raw as { task: string; maxNodes?: number; maxCode?: number };
      const args = ["context", a.task, "-f", "json"];
      if (a.maxNodes) args.push("-n", String(a.maxNodes));
      if (a.maxCode) args.push("-c", String(a.maxCode));
      return callCodegraph(args, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "codegraph_search",
    label: "CodeGraph search",
    description:
      "Find symbol DEFINITIONS by name (FTS5, scored, kind-filtered). Use when you have a name but no file:line anchor yet. Returns definition sites only — for USES of a known symbol use lsp_references. Beats grep on precision (kind-typed, no text noise).",
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
    async execute(_id: any, raw: any, signal: any, _onUpdate: any, ctx: any) {
      const a = raw as { query: string; kind?: string; limit?: number };
      const args = ["query", a.query, "-j"];
      if (a.kind) args.push("-k", a.kind);
      if (a.limit) args.push("-l", String(a.limit));
      return callCodegraph(args, ctx.cwd, signal);
    },
  });

  pi.registerTool({
    name: "codegraph_files",
    label: "CodeGraph files",
    description:
      "Project file tree from index with language + symbol-count per file. Use over find/ls when codegraph_status reports initialized.",
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
    async execute(_id: any, raw: any, signal: any, _onUpdate: any, ctx: any) {
      const a = raw as { filter?: string; pattern?: string; maxDepth?: number };
      const args = ["files", "-j"];
      if (a.filter) args.push("--filter", a.filter);
      if (a.pattern) args.push("--pattern", a.pattern);
      if (a.maxDepth) args.push("--max-depth", String(a.maxDepth));
      return callCodegraph(args, ctx.cwd, signal);
    },
  });
}
