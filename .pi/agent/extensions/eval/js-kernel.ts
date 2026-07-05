// Persistent JS kernel using node:vm. One context per session; cells share
// globalThis state across calls. Top-level await supported via async-IIFE wrap.
//
// Limitations vs Python:
// - State across cells lives on globalThis (or via the provided `state` helper),
//   not via plain `let`/`const`. Top-level lexical bindings inside the async
//   wrapper are scoped to the wrapper.
// - Last-expression auto-return uses a regex heuristic, not a full parser.

import * as vm from "node:vm";
import { createRequire } from "node:module";
import type { CellResult, DisplayItem } from "./types";

// CommonJS require resolved from this file, so cells can `require("node:fs")`,
// installed npm packages (extensions' node_modules), or any absolute path.
const cellRequire = createRequire(import.meta.url);

// Lets `await import("pkg")` inside a cell resolve through Node's real module
// loader instead of throwing "dynamic import callback invoked without ...".
// Guarded: only present on Node ≥ 20.10.
const dynamicImport = (
  vm as unknown as { constants?: { USE_MAIN_CONTEXT_DEFAULT_LOADER?: symbol } }
).constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER;

export interface JsKernelOptions {
  bridgeUrl: string;
  bridgeToken: string;
  bridgeSession: string;
}

interface ContextState {
  ctx: vm.Context;
  state: Record<string, unknown>;
}

interface Capture {
  stdout: string;
  stderr: string;
  displays: DisplayItem[];
}

// Build the console object and __emit_display wired to a specific capture
// buffer + onProgress tick. Called once per cell so each cell collects its
// own output even though the vm context is reused.
function makeCapture(capture: Capture, tick: () => void) {
  const printer =
    (stream: "stdout" | "stderr") =>
    (...args: unknown[]) => {
      const text =
        args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(" ") + "\n";
      capture[stream] += text;
      tick();
    };
  return {
    console: {
      log: printer("stdout"),
      info: printer("stdout"),
      warn: printer("stderr"),
      error: printer("stderr"),
      debug: printer("stdout"),
    },
    emitDisplay: (item: DisplayItem) => {
      capture.displays.push(item);
      tick();
    },
  };
}

// Detect whether the last top-level "line" looks like an expression we should
// auto-return. Skips wrap if the line starts with a statement keyword.
const STATEMENT_START =
  /^\s*(return|let|const|var|if|else|for|while|do|switch|case|default|try|catch|finally|throw|function|class|import|export|async\s+function|\}|\/\/|\/\*|;|$)/;

function wrapCell(code: string): string {
  const trimmed = code.replace(/\s+$/, "");
  if (!trimmed) return "(async () => {})()";
  // Find the start of the last top-level statement by walking backwards over
  // newlines and ignoring those inside braces/brackets/parens/strings. Simple
  // and imperfect; good enough for typical cell shapes.
  let depth = 0;
  let inStr: string | null = null;
  let lastBreak = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    const prev = i > 0 ? trimmed[i - 1] : "";
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if ((c === "\n" || c === ";") && depth === 0) lastBreak = i;
  }
  const head = lastBreak >= 0 ? trimmed.slice(0, lastBreak + 1) : "";
  const tail = (lastBreak >= 0 ? trimmed.slice(lastBreak + 1) : trimmed).trim();
  if (!tail || STATEMENT_START.test(tail)) {
    return `(async () => { ${trimmed}\n})()`;
  }
  return `(async () => { ${head}\nreturn (${tail});\n})()`;
}

// Names the tool proxy must NOT respond to, or we corrupt builtins like
// JSON.stringify and Promise resolution.
const TOOL_RESERVED = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "inspect",
  "constructor",
  "asymmetricMatch",
]);

const PRELUDE_JS = `
const display = (value) => {
  let mime = "application/json", data;
  try { data = JSON.stringify(value, null, 2); }
  catch { data = String(value); mime = "text/plain"; }
  globalThis.__emit_display({ mime, data });
};
const read = async (path, offset, limit) => {
  const args = { path };
  if (offset != null) args.offset = offset;
  if (limit != null) args.limit = limit;
  return await tool.read(args);
};
const write = async (path, content) => await tool.write({ path, content });
const tree = async (path = ".", max_depth = 3, show_hidden = false) =>
  await tool.tree({ path, max_depth, show_hidden });
const state = globalThis;
// console.log/error are wired by the host to capture stdout/stderr.
`;

export class JsKernel {
  #opts: JsKernelOptions;
  #ctxState: ContextState | null = null;
  #disposed = false;

  constructor(opts: JsKernelOptions) {
    this.#opts = opts;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  #buildContext(capture: Capture, tick: () => void): ContextState {
    const { bridgeUrl, bridgeToken, bridgeSession } = this.#opts;
    const toolProxy = new Proxy(
      {},
      {
        get: (_t, name) => {
          if (typeof name !== "string") return undefined;
          // Avoid poisoning JSON.stringify (toJSON), `await tool` (then),
          // util.inspect, and any V8 dev tooling that probes objects.
          if (TOOL_RESERVED.has(name)) return undefined;
          return async (args: unknown) => {
            const res = await fetch(`${bridgeUrl}/v1/tool`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${bridgeToken}`,
                Connection: "close",
              },
              body: JSON.stringify({
                session: bridgeSession,
                name,
                args: args ?? {},
              }),
              keepalive: false,
            });
            const data = (await res.json()) as {
              ok: boolean;
              value?: unknown;
              error?: string;
            };
            if (!data.ok) throw new Error(data.error ?? `tool.${name} failed`);
            return data.value;
          };
        },
      },
    );
    const { console: cons, emitDisplay } = makeCapture(capture, tick);
    const sandbox: Record<string, unknown> = {
      fetch,
      console: cons,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
      atob,
      btoa,
      structuredClone,
      crypto,
      process,
      require: cellRequire,
      global: undefined as unknown,
    };
    // `global` self-reference so Node-style code reading `global` works
    // (`globalThis` is already provided by the vm context).
    sandbox.global = sandbox;
    // tool + __emit_display are non-enumerable so cells returning globalThis
    // (e.g. `state`) don't dump the host scaffolding into JSON output.
    Object.defineProperty(sandbox, "tool", {
      value: toolProxy,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(sandbox, "__emit_display", {
      value: emitDisplay,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const ctx = vm.createContext(sandbox);
    vm.runInContext(PRELUDE_JS, ctx);
    return { ctx, state: sandbox };
  }

  #rebindCapture(
    ctxState: ContextState,
    capture: Capture,
    tick: () => void,
  ): void {
    const { console: cons, emitDisplay } = makeCapture(capture, tick);
    ctxState.state.console = cons;
    // __emit_display was defined non-enumerable; preserve that on rebind.
    Object.defineProperty(ctxState.state, "__emit_display", {
      value: emitDisplay,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  async run(
    code: string,
    timeoutSec: number,
    title: string | undefined,
    onProgress?: (r: CellResult) => void,
  ): Promise<CellResult> {
    if (this.#disposed) throw new Error("JS kernel disposed");
    const result: CellResult = {
      title,
      language: "js",
      stdout: "",
      stderr: "",
      value: null,
      error: null,
      displays: [],
      durationMs: 0,
    };
    const capture = {
      stdout: result.stdout,
      stderr: result.stderr,
      displays: result.displays,
    };
    const tick = () => {
      result.stdout = capture.stdout;
      result.stderr = capture.stderr;
      onProgress?.(result);
    };
    // Lazy build; rebind capture per-cell so each cell collects its own output.
    if (!this.#ctxState) this.#ctxState = this.#buildContext(capture, tick);
    else this.#rebindCapture(this.#ctxState, capture, tick);

    const wrapped = wrapCell(code);
    const startedAt = Date.now();
    // vm's `timeout` option only bounds the script's synchronous portion —
    // the wrapped code is an async IIFE that returns a Promise almost
    // immediately, so a cell awaiting a hung fetch/promise would otherwise
    // never time out. Race the returned promise against our own timer.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const asyncTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Script execution timed out after ${timeoutSec}s`));
      }, timeoutSec * 1000);
      timer.unref?.();
    });
    try {
      const promise = vm.runInContext(wrapped, this.#ctxState.ctx, {
        filename: "<cell>",
        timeout: timeoutSec * 1000,
        displayErrors: true,
        ...(dynamicImport
          ? { importModuleDynamically: dynamicImport as never }
          : {}),
      }) as Promise<unknown>;
      result.value = await Promise.race([promise, asyncTimeout]);
    } catch (err) {
      const e = err as Error;
      if (e && /Script execution timed out/i.test(e.message)) {
        result.timedOut = true;
        // The async IIFE may still be running against this context (e.g. a
        // hung fetch) with no way to cancel it — discard the context so it
        // can't keep mutating state or calling tools after this cell ends.
        this.#ctxState = null;
      }
      result.error = e?.stack ?? String(err);
    } finally {
      clearTimeout(timer);
      result.stdout = capture.stdout;
      result.stderr = capture.stderr;
      result.durationMs = Date.now() - startedAt;
    }
    // Coerce non-serializable values to a string for the wire.
    try {
      JSON.stringify(result.value);
    } catch {
      result.value = result.value === undefined ? null : String(result.value);
    }
    return result;
  }

  reset(): void {
    this.#ctxState = null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#ctxState = null;
  }
}
