import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  formatSize,
  truncateHead,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTool,
  AgentToolCallOutcome,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { TextContent, Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  registerBridgeSession,
  setBridgeSignal,
  type BridgeHandler,
  type BridgeRegistration,
} from "./bridge.ts";
import { PyKernel } from "./py-kernel.ts";
import type { CellResult } from "./types.ts";
import { addUsage, sideChannelComplete } from "../shared/llm.ts";

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
  fallbacks: Record<string, AgentTool<any>> | null;
  ctx: ExtensionToolContext | null;
  usage: Usage | null;
  calls: ToolCallRecord[];
}

interface ToolCallRecord {
  name: string;
  status: "running" | "ok" | "error";
}

interface ExecutionDetails {
  totalCells: number;
  completedCells: number;
  failedCell?: number;
  aborted?: boolean;
  timedOut?: boolean;
  durationMs: number;
  fullOutputPath?: string;
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

function callableTools(state: SessionState) {
  return (state.ctx?.tools ?? []).filter((tool) => tool.name !== "eval");
}

function bridgeHandler(state: SessionState): BridgeHandler {
  return async (name, args, signal) => {
    switch (name) {
      case "list":
        return [
          ...new Set([
            ...callableTools(state).map((tool) => tool.name),
            ...Object.keys(ensureFallbacks(state)),
            "tree",
            "completion",
            "list",
            "describe",
          ]),
        ].sort();
      case "describe": {
        const tool =
          callableTools(state).find((t) => t.name === args.name) ??
          ensureFallbacks(state)[String(args.name)];
        if (!tool) throw new Error(`unknown tool: ${String(args.name)}`);
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          output_schema: tool.outputSchema ?? {
            type: "string",
          },
        };
      }
    }
    const tool = callableTools(state).find((t) => t.name === name);
    if (tool && state.ctx?.executeTool) {
      const record = recordCall(state, name);
      const outcome = await state.ctx.executeTool(name, args, { signal });
      record.status = outcome.isError ? "error" : "ok";
      return toPythonValue(name, tool.outputSchema, outcome);
    }
    const fallback = ensureFallbacks(state)[name];
    if (fallback) {
      const record = recordCall(state, name);
      const result = await fallback.execute(
        `eval-bridge-${randomUUID()}`,
        args as Static<typeof fallback.parameters>,
        signal,
      );
      record.status = "ok";
      return flattenToolResult(result);
    }
    switch (name) {
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
        state.usage = addUsage(state.usage, result.usage);
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

function recordCall(state: SessionState, name: string): ToolCallRecord {
  const record: ToolCallRecord = { name, status: "running" };
  state.calls.push(record);
  return record;
}

function formatCallLog(calls: ToolCallRecord[]): string {
  if (calls.length === 0) return "";
  const counts = new Map<string, number>();
  for (const call of calls) {
    const status = call.status === "running" ? "interrupted" : call.status;
    const key = `${call.name} (${status})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const list = [...counts]
    .map(([key, count]) => (count > 1 ? `${key} x${count}` : key))
    .join(", ");
  return `Tool calls made before the failure (they are not undone): ${list}.`;
}

function ensureFallbacks(state: SessionState): Record<string, AgentTool<any>> {
  if (state.fallbacks) return state.fallbacks;
  const tools = [
    createReadTool(state.cwd),
    createGrepTool(state.cwd),
    createFindTool(state.cwd),
    createLsTool(state.cwd),
  ] as unknown as AgentTool<any>[];
  state.fallbacks = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return state.fallbacks;
}

function textOf(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function flattenToolResult(result: AgentToolResult<unknown>): unknown {
  const text = textOf(result);
  const images = result.content.filter((c) => c.type === "image");
  return images.length === 0 ? text : { text, images };
}

function toPythonValue(
  name: string,
  outputSchema: unknown,
  outcome: AgentToolCallOutcome,
): unknown {
  const { result } = outcome;
  if (outputSchema && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (outcome.isError) throw new Error(textOf(result) || `tool.${name} failed`);
  return flattenToolResult(result);
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

function outputBudget(summary: string) {
  return {
    maxBytes: Math.max(
      1024,
      DEFAULT_MAX_BYTES - Buffer.byteLength(summary) - 512,
    ),
    maxLines: Math.max(2, DEFAULT_MAX_LINES - 4),
  };
}

function boundOutput(summary: string, body: string): string {
  if (!body) return summary;
  const bounded = truncateTail(body, outputBudget(summary));
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

async function boundFinal(
  summary: string,
  body: string,
): Promise<{ text: string; fullOutputPath?: string }> {
  const { maxBytes, maxLines } = outputBudget(summary);
  if (
    !body ||
    (Buffer.byteLength(body) <= maxBytes && body.split("\n").length <= maxLines)
  ) {
    return { text: body ? `${summary}\n\n${body}` : summary };
  }
  const head = truncateHead(body, {
    maxBytes: Math.floor(maxBytes / 2),
    maxLines: Math.floor(maxLines / 2),
  });
  const tail = truncateTail(body, {
    maxBytes: maxBytes - head.outputBytes,
    maxLines: maxLines - head.outputLines,
  });
  const omitted = head.totalBytes - head.outputBytes - tail.outputBytes;
  let fullOutputPath: string | undefined = path.join(
    os.tmpdir(),
    `pi-eval-${randomUUID()}.txt`,
  );
  let saved: string;
  try {
    await fs.writeFile(fullOutputPath, body);
    saved = `Full output: ${fullOutputPath} (read it with offset and limit).`;
  } catch (err) {
    fullOutputPath = undefined;
    saved = `Could not save the full output: ${err instanceof Error ? err.message : String(err)}.`;
  }
  const note =
    `[Output truncated: kept the first ${head.outputLines} and last ${tail.outputLines} ` +
    `of ${head.totalLines} lines (${formatSize(head.totalBytes)}). ${saved}]`;
  const text = [
    summary,
    head.content,
    `[… ${formatSize(Math.max(0, omitted))} omitted …]`,
    tail.content,
    note,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, ...(fullOutputPath ? { fullOutputPath } : {}) };
}

const DESCRIPTION = `Run persistent Python for iterative computation and orchestrating tool calls.
- Cells run in order in one CPython process. Variables, imports, and loaded data persist across cells and calls until a cell sets \`reset\`.
- A cell's last expression is its value. \`print()\` output and \`display(value)\` also reach the result.
- The kernel has full file system, network, and subprocess access. It is not a sandbox.
- Call a tool with \`tool.<name>(args_dict)\` or \`tool.<name>(key=value)\`. Calls block until the tool finishes.
- A tool listed under "Tool results" returns a dict. Any other tool returns its text as one string.
- A failed, blocked, or invalid tool call raises RuntimeError with the tool's error text. \`tool.bash\` returns \`exit_code\` instead of raising on a non-zero exit.
- Tool calls are real and have side effects. A cell that fails partway does not undo earlier calls.
- The first failed cell stops the remaining cells. A cell times out after \`timeout\` seconds.
- Output over 2000 lines or 50KB keeps its start and end, and the full text goes to a temp file named in the result. Keep raw data in variables and return a compact aggregate.

Helpers:
- \`parallel(calls: list[tuple[str, dict]], max_workers=8) -> list\`: runs tool calls concurrently and returns results in input order, with the exception object in the slot of a failed call.
- \`tool.list() -> list[str]\`: callable tool names.
- \`tool.describe(name=...) -> dict\`: one tool's description, input schema, and output schema.
- \`read(path, offset=None, limit=None)\`, \`write(path, content)\`, \`tree(path=".", max_depth=3, show_hidden=False)\`: shorthands for file work.
- \`env(key=None, value=None)\`: reads or sets environment variables of this kernel only.
- \`completion(prompt, model="default", system=None, schema=None)\`: one stateless model call. With a JSON Schema \`schema\`, returns parsed JSON.
- \`install(*pkgs, upgrade=False)\`: installs Python packages that persist across sessions.`;

function schemaType(schema: unknown, depth = 0): string {
  const s = (schema ?? {}) as Record<string, any>;
  if ("const" in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum))
    return s.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(s.anyOf ?? s.oneOf)) {
    return (s.anyOf ?? s.oneOf)
      .map((x: unknown) => schemaType(x, depth))
      .join(" | ");
  }
  const type = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (type === "array") return `list[${schemaType(s.items, depth + 1)}]`;
  if (type === "object" || s.properties) {
    if (!s.properties || depth > 2) return "dict";
    const required = new Set<string>(s.required ?? []);
    const fields = Object.entries(s.properties).map(
      ([key, value]) =>
        `${key}${required.has(key) ? "" : "?"}: ${schemaType(value, depth + 1)}`,
    );
    return `{${fields.join(", ")}}`;
  }
  return (
    (
      {
        string: "str",
        number: "number",
        integer: "int",
        boolean: "bool",
        null: "None",
      } as Record<string, string>
    )[type] ?? "any"
  );
}

function describeCallable(loadout: ToolLoadout): string {
  const { declared, callable } = loadout;
  const tools = callable.filter(
    (tool) =>
      tool.name !== "eval" && loadout.getExposure(tool.name) !== "deferred",
  );
  const structured = tools.filter((tool) => tool.outputSchema);
  const declaredNames = new Set(declared.map((tool) => tool.name));
  const hidden = tools.filter((tool) => !declaredNames.has(tool.name));
  const sections = [DESCRIPTION];
  if (structured.length > 0) {
    sections.push(
      `Tool results:\n${structured.map((tool) => `- \`${tool.name}\` -> ${schemaType(tool.outputSchema)}`).join("\n")}`,
    );
  }
  if (hidden.length > 0) {
    sections.push(
      `Callable from cells only (\`tool.describe\` shows the schema):\n${hidden
        .map((tool) => `- \`${tool.name}\`: ${tool.description.split("\n")[0]}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
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
    fallbacks: null,
    ctx: null,
    usage: null,
    calls: [],
  };
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.py?.dispose();
    state.py = null;
    state.registration?.unregister();
    state.registration = null;
    state.fallbacks = null;
    state.ctx = null;
  };

  pi.on("session_shutdown", cleanup);
  pi.registerTool({
    name: "eval",
    label: "Eval",
    description: DESCRIPTION,
    promptSnippet:
      "Run persistent Python that keeps state between calls and calls other tools (loops, parallel(), filtering large results, data work)",
    promptGuidelines: [
      "Use eval to batch or chain several tool calls, to filter large tool output down to what you need, or to iterate on data across calls, instead of issuing many individual tool calls. Batch independent calls in one cell with parallel([...]). Use bash or read directly for a single one-off call.",
    ],
    exposure: "model-only",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    prepareLoadout: (loadout) => ({
      descriptions: {
        eval: describeCallable(loadout),
      },
    }),
    parameters: EvalParams,
    executionMode: "sequential",
    async execute(_callId, params: EvalParamsT, signal, onUpdate, ctx) {
      if (cleaned) throw new Error("eval extension is shut down");
      if (signal?.aborted) throw new Error("eval aborted before cell start");
      const stateLost =
        !params.cells[0]?.reset &&
        !(state.py?.alive && state.cwd === ctx.cwd) &&
        ctx.sessionManager.getBranch().some((entry) => {
          const message = (
            entry as { message?: { role?: string; toolName?: string } }
          ).message;
          return (
            entry.type === "message" &&
            message?.role === "toolResult" &&
            message.toolName === "eval"
          );
        });
      if (state.cwd && state.cwd !== ctx.cwd) {
        state.py?.dispose();
        state.py = null;
        state.registration?.unregister();
        state.registration = null;
        state.fallbacks = null;
      }
      state.cwd = ctx.cwd;
      state.ctx = ctx;
      state.usage = null;
      state.calls = [];
      const startedAt = performance.now();
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
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      const ran = `${results.length}/${params.cells.length} cells ran in ${seconds}s.`;
      const summary =
        failedCell === undefined
          ? `${results.length} cells ran in ${seconds}s.`
          : signal?.aborted || last?.aborted
            ? `Cell ${failedCell + 1} aborted. ${ran}`
            : last?.timedOut
              ? `Cell ${failedCell + 1} timed out. ${ran}`
              : `Cell ${failedCell + 1} failed. ${ran}`;
      const body = results.map((r, i) => formatResult(r, i)).join("\n\n");
      const { text, fullOutputPath } = await boundFinal(
        [
          stateLost
            ? `${summary} The Python kernel restarted before this call, so variables from earlier eval calls are gone.`
            : summary,
          failedCell === undefined ? "" : formatCallLog(state.calls),
        ]
          .filter(Boolean)
          .join("\n"),
        body,
      );

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
      // isError instead of a throw: a thrown error drops details and usage.
      return {
        content,
        details: {
          ...details(results, params.cells.length),
          ...(fullOutputPath ? { fullOutputPath } : {}),
        },
        ...(state.usage ? { usage: state.usage } : {}),
        ...(failedCell !== undefined ? { isError: true } : {}),
      };
    },
  });
}
