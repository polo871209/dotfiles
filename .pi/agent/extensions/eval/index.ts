// eval — persistent Python kernel with a loopback tool bridge.
//
// Mirrors the omp/oh-my-pi "Code execution w/ tool-calling" pattern: cell code
// inside the kernel can call `tool.read({...})`, `tool.write(...)`, `tree(...)`
// which round-trip back into this host extension via a local HTTP bridge.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TextContent } from "@earendil-works/pi-ai";
import {
  registerBridgeSession,
  setBridgeSignal,
  type BridgeHandler,
  type BridgeRegistration,
} from "./bridge";
import { PyKernel } from "./py-kernel";
import { JsKernel } from "./js-kernel";
import type { CellResult } from "./types";

const Cell = Type.Object({
  language: Type.Union([Type.Literal("py"), Type.Literal("js")]),
  code: Type.String(),
  title: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
  reset: Type.Optional(Type.Boolean()),
});

const EvalParams = Type.Object({
  cells: Type.Array(Cell, { minItems: 1 }),
});

type EvalParamsT = Static<typeof EvalParams>;

interface SessionState {
  py: PyKernel | null;
  js: JsKernel | null;
  registration: BridgeRegistration | null;
  cwd: string;
  // AgentTool's generic is constrained to TSchema; `any` here is unavoidable.
  builtins: Record<string, AgentTool<any>> | null;
}

const sessions = new Map<string, SessionState>();

function bridgeHandler(state: SessionState): BridgeHandler {
  return async (name, args, signal) => {
    // Forward to pi's built-in tools when a matching one exists.
    const builtins = ensureBuiltins(state);
    if (builtins[name]) {
      const t = builtins[name]!;
      const id = `eval-bridge-${randomUUID()}`;
      const result = await t.execute(
        id,
        args as Static<typeof t.parameters>,
        signal,
      );
      return flattenToolResult(result);
    }
    switch (name) {
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
            const branch = last ? "└── " : "├── ";
            out.push(
              `${prefix}${branch}${e.name}${e.isDirectory() ? "/" : ""}`,
            );
            if (e.isDirectory()) {
              await walk(
                path.join(dir, e.name),
                depth + 1,
                prefix + (last ? "    " : "│   "),
              );
            }
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

function getSession(sessionFile: string, cwd: string): SessionState {
  let state = sessions.get(sessionFile);
  if (state) {
    if (state.cwd !== cwd) {
      state.cwd = cwd;
      state.builtins = null;
    }
    return state;
  }
  state = { py: null, js: null, registration: null, cwd, builtins: null };
  sessions.set(sessionFile, state);
  return state;
}

function ensureBuiltins(state: SessionState): Record<string, AgentTool<any>> {
  if (state.builtins) return state.builtins;
  const cwd = state.cwd;
  const tools = [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
  ] as unknown as AgentTool<any>[];
  const map: Record<string, AgentTool<any>> = {};
  for (const t of tools) map[t.name] = t;
  state.builtins = map;
  return state.builtins;
}

function flattenToolResult(result: AgentToolResult<unknown>): unknown {
  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
  const images = result.content.filter((c) => c.type === "image");
  if (images.length === 0) return text;
  return { text, images };
}

async function ensureBridge(state: SessionState): Promise<BridgeRegistration> {
  if (state.registration) return state.registration;
  state.registration = await registerBridgeSession(bridgeHandler(state));
  return state.registration;
}

async function ensurePyKernel(state: SessionState): Promise<PyKernel> {
  // Recycle a dead kernel: once the interpreter exits (OOM kill, native
  // segfault, os._exit, host crash) the cached handle is permanently closed,
  // so reusing it would throw "python kernel has exited" for the rest of the
  // session. Drop it and spawn a fresh one transparently.
  if (state.py?.alive) return state.py;
  state.py = null;
  const reg = await ensureBridge(state);
  const kernel = new PyKernel({
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

async function ensureJsKernel(state: SessionState): Promise<JsKernel> {
  if (state.js) return state.js;
  const reg = await ensureBridge(state);
  state.js = new JsKernel({
    bridgeUrl: reg.url,
    bridgeToken: reg.token,
    bridgeSession: reg.session,
  });
  await state.js.ready();
  return state.js;
}

function formatResult(r: CellResult, idx: number): string {
  const head = `[${idx + 1}/${r.title || "cell"}] (${r.durationMs}ms${r.timedOut ? " TIMEOUT" : ""})`;
  const parts = [head];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr) parts.push(`stderr:\n${r.stderr.trimEnd()}`);
  for (const d of r.displays) {
    if (d.mime === "image/png")
      parts.push(`<image ${d.mime} ${d.data.length}b>`);
    else parts.push(`display(${d.mime}):\n${d.data}`);
  }
  if (r.value !== null && r.value !== undefined) {
    parts.push(
      `=> ${typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2)}`,
    );
  }
  if (r.error) parts.push(`ERROR:\n${r.error.trimEnd()}`);
  return parts.join("\n");
}

export default function (pi: ExtensionAPI) {
  // pi installs no unhandledRejection handler, so Node's default (terminate)
  // applies process-wide. A stray async rejection anywhere — a kernel pipe
  // dying, an aborted bridge fetch — would otherwise exit pi. Having a listener
  // suppresses the default; we log every rejection (so genuine bugs stay
  // visible in stderr) but NEVER re-throw, because re-throwing here was turning
  // recoverable hiccups into hard pi crashes.
  const onUnhandled = (reason: unknown) => {
    const msg =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
    const evalOrigin =
      /eval-bridge|eval\/(bridge|py-kernel|js-kernel|index)/.test(msg);
    process.stderr.write(
      `[eval extension] swallowed unhandled rejection${evalOrigin ? "" : " (non-eval origin)"}: ${msg}\n`,
    );
  };
  // Reloads re-run this default() without firing session_shutdown, so an old
  // listener can linger; drop any prior instance before adding ours.
  process.off("unhandledRejection", onUnhandled);
  process.on("unhandledRejection", onUnhandled);

  pi.on("session_shutdown", async () => {
    process.off("unhandledRejection", onUnhandled);
    for (const state of sessions.values()) {
      state.py?.dispose();
      state.js?.dispose();
      state.registration?.unregister();
    }
    sessions.clear();
  });

  pi.registerTool({
    name: "eval",
    label: "Eval",
    description:
      'Run code in persistent Python and JavaScript kernels. Each language has one kernel per session; state persists across cells and across separate tool calls. Set `language: "py"` or `language: "js"` per cell. Python runs in a managed venv at `~/.cache/pi-eval/venv`; call `install("pkg1", "pkg2")` (uv under the hood) to add packages — they persist across pi restarts. Inside any cell, call `tool.<name>({...})` to invoke pi built-in tools over a loopback bridge: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` use their normal pi argument schemas; `tree({path,max_depth})` is an extra helper. Shortcuts: `read(path)`, `write(path,content)`, `tree(path)`. JS cells support top-level await; cross-cell state in JS lives on `globalThis` / `state` (since `let`/`const` are scoped to the wrapping async IIFE).',
    promptSnippet:
      "eval: persistent py + js kernels; share state across tool calls; `tool.*` proxy invokes pi tools (read/write/edit/bash/grep/find/ls/tree).",
    parameters: EvalParams,
    async execute(_callId, params: EvalParamsT, signal, onUpdate, ctx) {
      try {
        const sessionFile = ctx.sessionManager.getSessionFile?.() ?? "default";
        const state = getSession(sessionFile, ctx.cwd);
        state.cwd = ctx.cwd;
        // Make the current call's signal available to bridge tool calls.
        const reg = await ensureBridge(state);
        setBridgeSignal(reg.session, signal);

        const results: CellResult[] = [];
        let firstError: number | null = null;
        const emit = (extra?: Partial<{ status: string }>) => {
          try {
            onUpdate?.({ results, ...extra } as unknown as never);
          } catch {}
        };

        try {
          for (let i = 0; i < params.cells.length; i++) {
            if (signal?.aborted) break;
            const cell = params.cells[i]!;
            if (cell.reset) {
              if (cell.language === "py") {
                state.py?.dispose();
                state.py = null;
              } else {
                state.js?.reset();
                state.js = null;
              }
            }
            emit({
              status: `[${i + 1}/${params.cells.length}] ${cell.language}${cell.title ? " " + cell.title : ""}`,
            });
            const onProgress = (partial: CellResult) => {
              const snapshot = [...results, partial];
              try {
                onUpdate?.({ results: snapshot } as unknown as never);
              } catch {}
            };
            let r: CellResult;
            if (cell.language === "py") {
              const kernel = await ensurePyKernel(state);
              r = await kernel.run(
                cell.code,
                cell.timeout ?? 30,
                cell.title,
                onProgress,
              );
              if (r.timedOut) {
                state.py = null;
              }
            } else {
              const kernel = await ensureJsKernel(state);
              r = await kernel.run(
                cell.code,
                cell.timeout ?? 30,
                cell.title,
                onProgress,
              );
            }
            results.push(r);
            emit();
            if (r.error) {
              firstError = i;
              break;
            }
          }
        } finally {
          setBridgeSignal(reg.session, undefined);
        }

        const body = results.map((r, i) => formatResult(r, i)).join("\n\n");
        const summary =
          firstError !== null
            ? `Cell ${firstError + 1} failed. ${results.length}/${params.cells.length} cells ran.`
            : `${results.length} cells ran.`;

        return {
          content: [{ type: "text", text: `${summary}\n\n${body}` }],
          details: { results, isError: firstError !== null },
          isError: firstError !== null,
        };
      } catch (err) {
        // Last line of defence: execute() must never reject, or pi surfaces it as
        // "No result provided" (and an unhandled rejection can take pi down).
        // Return the failure as a normal tool error so the kernel/bridge can be
        // debugged from the conversation.
        const msg =
          err instanceof Error ? (err.stack ?? err.message) : String(err);
        process.stderr.write(`[eval extension] execute() failed: ${msg}\n`);
        return {
          content: [
            { type: "text", text: `eval failed (host error):\n${msg}` },
          ],
          details: { isError: true },
          isError: true,
        };
      }
    },
  });
}
