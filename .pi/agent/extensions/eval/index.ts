import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Static,
  type TextContent,
} from "@earendil-works/pi-ai/compat";
import {
  registerBridgeSession,
  setBridgeSignal,
  type BridgeHandler,
  type BridgeRegistration,
} from "./bridge.ts";
import { PyKernel } from "./py-kernel.ts";
import type { CellResult } from "./types.ts";
import { sideChannelComplete } from "../shared/llm.ts";
import { evalBridgeTools } from "../shared/bridge-tools.ts";

const Cell = Type.Object(
  {
    code: Type.String({
      description:
        "Python code to execute; final expression becomes cell value.",
    }),
    title: Type.Optional(
      Type.String({ description: "Short label for this cell's result." }),
    ),
    timeout: Type.Optional(
      Type.Number({
        description: "Cell timeout in seconds; defaults to 30, range 1 to 600.",
        minimum: 1,
        maximum: 600,
      }),
    ),
    reset: Type.Optional(
      Type.Boolean({
        description: "Start this cell in a fresh Python kernel and state.",
      }),
    ),
  },
  { additionalProperties: false },
);

const EvalParams = Type.Object(
  {
    cells: Type.Array(Cell, {
      description:
        "Python cells run sequentially and stop after the first error.",
      minItems: 1,
    }),
  },
  { additionalProperties: false },
);

type EvalParamsT = Static<typeof EvalParams>;

interface SessionState {
  py: PyKernel | null;
  registration: BridgeRegistration | null;
  cwd: string;
  builtins: Record<string, AgentTool<any>> | null;
  ctx: ExtensionContext | null;
}

interface ExecutionDetails {
  totalCells: number;
  completedCells: number;
  failedCell?: number;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs: number;
}

function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function buildCompletionSystem(system: unknown, schema: unknown): string {
  const base =
    typeof system === "string" && system.trim()
      ? system.trim()
      : "Answer directly. No preamble, no meta-commentary.";
  if (!schema) return base;
  return `${base}\n\nRespond with ONLY a single JSON value matching this JSON Schema, no prose, no code fence:\n${JSON.stringify(schema)}`;
}

function resolveCompletionModel(ctx: ExtensionContext, spec: unknown) {
  if (typeof spec !== "string" || !spec.trim() || spec === "default") {
    return undefined;
  }
  const slash = spec.indexOf("/");
  if (slash < 1) {
    throw new Error(
      `completion: model must be "provider/id" or "default", got ${JSON.stringify(spec)}`,
    );
  }
  const model = ctx.modelRegistry.find(
    spec.slice(0, slash),
    spec.slice(slash + 1),
  );
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(
      `completion: model "${spec}" is unavailable or unauthenticated`,
    );
  }
  return model;
}

function bridgeHandler(state: SessionState): BridgeHandler {
  return async (name, args, signal) => {
    const builtins = ensureBuiltins(state);
    if (builtins[name]) {
      const t = builtins[name]!;
      const result = await t.execute(
        `eval-bridge-${randomUUID()}`,
        args as Static<typeof t.parameters>,
        signal,
      );
      return flattenToolResult(result);
    }
    const ext = evalBridgeTools().get(name);
    if (ext) {
      if (!state.ctx)
        throw new Error(`tool.${name} unavailable: no active tool context`);
      const result = await ext.execute(
        `eval-bridge-${randomUUID()}`,
        args,
        signal,
        undefined,
        state.ctx,
      );
      return flattenToolResult(result);
    }
    switch (name) {
      case "list":
        return [
          ...Object.keys(ensureBuiltins(state)),
          ...evalBridgeTools().keys(),
          "tree",
          "completion",
          "list",
        ].sort();
      case "completion": {
        if (!state.ctx)
          throw new Error("completion unavailable: no active tool context");
        const promptText = String(args.prompt ?? "").trim();
        if (!promptText)
          throw new Error("completion requires a non-empty prompt");
        const schema = args.schema;
        const result = await sideChannelComplete(state.ctx, {
          systemPrompt: buildCompletionSystem(args.system, schema),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: promptText }],
              timestamp: Date.now(),
            },
          ],
          model: resolveCompletionModel(state.ctx, args.model),
          signal,
        });
        if (!result.ok)
          throw new Error(
            `completion failed: ${result.error ?? result.reason}`,
          );
        if (schema) {
          try {
            return JSON.parse(extractJsonText(result.text));
          } catch {
            return result.text;
          }
        }
        return result.text;
      }
      case "tree": {
        const base = String(args.path ?? ".");
        const maxDepth = Number(args.max_depth ?? 3);
        const showHidden = Boolean(args.show_hidden ?? false);
        const root = path.resolve(state.cwd, base);
        const out: string[] = [path.basename(root) || root];
        async function walk(dir: string, depth: number, prefix: string) {
          if (depth > maxDepth) return;
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          entries = entries
            .filter((e) => showHidden || !e.name.startsWith("."))
            .sort((a, b) => a.name.localeCompare(b.name));
          for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            if (!e) continue;
            const last = i === entries.length - 1;
            out.push(
              `${prefix}${last ? "└── " : "├── "}${e.name}${e.isDirectory() ? "/" : ""}`,
            );
            if (e.isDirectory())
              await walk(
                path.join(dir, e.name),
                depth + 1,
                prefix + (last ? "    " : "│   "),
              );
          }
        }
        await walk(root, 1, "");
        return out.join("\n");
      }
      default:
        throw new Error(`unknown bridge tool: ${name}`);
    }
  };
}

function ensureBuiltins(state: SessionState): Record<string, AgentTool<any>> {
  if (state.builtins) return state.builtins;
  const tools = [
    createReadTool(state.cwd),
    createWriteTool(state.cwd),
    createEditTool(state.cwd),
    createBashTool(state.cwd),
    createGrepTool(state.cwd),
    createFindTool(state.cwd),
    createLsTool(state.cwd),
  ] as unknown as AgentTool<any>[];
  state.builtins = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return state.builtins;
}

function flattenToolResult(result: AgentToolResult<unknown>): unknown {
  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const images = result.content.filter((c) => c.type === "image");
  return images.length === 0 ? text : { text, images };
}

async function ensureBridge(state: SessionState): Promise<BridgeRegistration> {
  if (state.registration) return state.registration;
  state.registration = await registerBridgeSession(bridgeHandler(state));
  return state.registration;
}

async function ensurePyKernel(state: SessionState): Promise<PyKernel> {
  if (state.py?.alive) return state.py;
  state.py = null;
  const reg = await ensureBridge(state);
  const kernel = new PyKernel({
    cwd: state.cwd,
    bridgeUrl: reg.url,
    bridgeToken: reg.token,
    bridgeSession: reg.session,
  });
  try {
    await kernel.ready();
  } catch (err) {
    kernel.dispose();
    throw err;
  }
  state.py = kernel;
  return kernel;
}

function formatResult(r: CellResult, idx: number): string {
  const head = `[${idx + 1}]${r.title ? ` ${r.title}` : ""}${r.timedOut ? " TIMEOUT" : r.aborted ? " ABORTED" : ""}`;
  const parts = [head];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  for (const d of r.displays) {
    parts.push(
      d.mime === "image/png"
        ? `<image ${d.mime} ${d.data.length}b>`
        : `display(${d.mime}):\n${d.data}`,
    );
  }
  if (r.value !== null && r.value !== undefined) {
    parts.push(
      `=> ${typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)}`,
    );
  }
  if (r.error) parts.push(`ERROR:\n${r.error.trimEnd()}`);
  return parts.join("\n");
}

function boundOutput(summary: string, body: string): string {
  if (!body) return summary;
  const budget = Math.max(
    1024,
    DEFAULT_MAX_BYTES - Buffer.byteLength(summary) - 512,
  );
  const bounded = truncateTail(body, {
    maxBytes: budget,
    maxLines: Math.max(1, DEFAULT_MAX_LINES - 4),
  });
  const parts = [summary];
  if (bounded.content) parts.push(bounded.content);
  if (bounded.truncated) {
    parts.push(
      `[Output truncated: showing last ${bounded.outputLines}/${bounded.totalLines} lines ` +
        `(${formatSize(bounded.outputBytes)}/${formatSize(bounded.totalBytes)}). ` +
        "Return a smaller aggregate or write full output to a file.]",
    );
  }
  return parts.join("\n\n");
}

function details(
  results: CellResult[],
  total: number,
  failedCell?: number,
  aborted = false,
): ExecutionDetails {
  const last = results.at(-1);
  return {
    totalCells: total,
    completedCells: results.length,
    ...(failedCell === undefined ? {} : { failedCell: failedCell + 1 }),
    ...(aborted || last?.aborted ? { aborted: true } : {}),
    ...(last?.timedOut ? { timedOut: true } : {}),
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
  };
}

export default function (pi: ExtensionAPI) {
  const state: SessionState = {
    py: null,
    registration: null,
    cwd: "",
    builtins: null,
    ctx: null,
  };
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.py?.dispose();
    state.py = null;
    state.registration?.unregister();
    state.registration = null;
    state.builtins = null;
    state.ctx = null;
  };

  pi.on("session_shutdown", cleanup);
  pi.registerTool({
    name: "eval",
    label: "Eval",
    description:
      "Run persistent Python for iterative computation and bulk tool aggregation. Use `bash` or `read` for one-off work. State persists across cells and calls. Use `tool.<name>(args)` inside cells for bulk tool work; discover names with `tool.list()`. Keep raw responses in the kernel and return a compact aggregate. Helpers: `read`, `write`, `tree`, `env`, `completion`, and `install`; installed packages persist across Pi sessions. Large output is truncated; return a smaller aggregate or write it to a file.",
    promptSnippet:
      "eval: persistent Python for iterative computation and bulk aggregation; use bash/read for one-off work, discover bridged tools with `tool.list()`, and return a compact aggregate.",
    parameters: EvalParams,
    executionMode: "sequential",
    async execute(_callId, params: EvalParamsT, signal, onUpdate, ctx) {
      if (cleaned) throw new Error("eval extension is shut down");
      if (signal?.aborted) throw new Error("eval aborted before cell start");
      if (state.cwd && state.cwd !== ctx.cwd) {
        state.py?.dispose();
        state.py = null;
        state.registration?.unregister();
        state.registration = null;
        state.builtins = null;
      }
      state.cwd = ctx.cwd;
      state.ctx = ctx;
      const reg = await ensureBridge(state);
      setBridgeSignal(reg.session, signal);
      const results: CellResult[] = [];
      let failedCell: number | undefined;

      const emit = (status?: string, active?: CellResult) => {
        const summary = `[${results.length}/${params.cells.length} cells]`;
        const visible = active ? [...results, active] : results;
        const output = visible.map((r, i) => formatResult(r, i)).join("\n\n");
        const body =
          [output, status].filter(Boolean).join("\n\n") || "running…";
        try {
          onUpdate?.({
            content: [
              { type: "text" as const, text: boundOutput(summary, body) },
            ],
            details: details(
              results,
              params.cells.length,
              failedCell,
              signal?.aborted,
            ),
          });
        } catch {}
      };

      try {
        for (let i = 0; i < params.cells.length; i++) {
          if (signal?.aborted) {
            failedCell = i;
            break;
          }
          const cell = params.cells[i]!;
          if (cell.reset) {
            state.py?.dispose();
            state.py = null;
          }
          emit(
            `[${i + 1}/${params.cells.length}]${cell.title ? ` ${cell.title}` : " cell"}`,
          );
          const kernel = await ensurePyKernel(state);
          const result = await kernel.run(
            cell.code,
            cell.timeout ?? 30,
            cell.title,
            (partial) => emit(undefined, partial),
            signal,
          );
          results.push(result);
          if (result.error) failedCell = i;
          emit();
          if (failedCell !== undefined) break;
        }
      } finally {
        setBridgeSignal(reg.session, undefined);
      }

      const last = results.at(-1);
      const summary =
        failedCell === undefined
          ? `${results.length} cells ran.`
          : signal?.aborted || last?.aborted
            ? `Cell ${failedCell + 1} aborted. ${results.length}/${params.cells.length} cells ran.`
            : last?.timedOut
              ? `Cell ${failedCell + 1} timed out. ${results.length}/${params.cells.length} cells ran.`
              : `Cell ${failedCell + 1} failed. ${results.length}/${params.cells.length} cells ran.`;
      const body = results.map((r, i) => formatResult(r, i)).join("\n\n");
      const text = boundOutput(summary, body);
      if (failedCell !== undefined) throw new Error(text);

      const content: (
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      )[] = [{ type: "text", text }];
      for (const result of results) {
        for (const display of result.displays) {
          if (display.mime.startsWith("image/")) {
            content.push({
              type: "image",
              data: display.data,
              mimeType: display.mime,
            });
          }
        }
      }
      return { content, details: details(results, params.cells.length) };
    },
  });
}
