// Long-lived Python kernel: spawn `python3 runner.py`, multiplex requests over
// stdin and events over fd 3.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CellResult,
  DisplayItem,
  KernelEvent,
  KernelRequest,
} from "./types";

interface PendingRun {
  id: string;
  resolve: (r: CellResult) => void;
  result: CellResult;
  startedAt: number;
  timeoutSec: number;
  timeout: NodeJS.Timeout | null;
  escalation: NodeJS.Timeout | null;
  interruptReason: "aborted" | "timedOut" | null;
  onProgress?: (r: CellResult) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const INTERRUPT_GRACE_MS = 2000;

interface VenvInfo {
  dir: string;
  python: string;
}

let cachedVenv: VenvInfo | null = null;
const PYTHON_VERSION = "3.14";

function venvPythonMinor(dir: string): string | null {
  try {
    const cfg = fs.readFileSync(path.join(dir, "pyvenv.cfg"), "utf-8");
    const m = cfg.match(/^version(?:_info)?\s*=\s*(\d+\.\d+)/m);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function ensureVenv(): VenvInfo {
  if (cachedVenv) return cachedVenv;
  const dir = path.join(os.homedir(), ".cache", "pi-eval", "venv");
  const python = path.join(dir, "bin", "python");
  const stale =
    fs.existsSync(python) && venvPythonMinor(dir) !== PYTHON_VERSION;
  if (stale) fs.rmSync(dir, { recursive: true, force: true });
  if (stale || !fs.existsSync(python)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = spawnSync(
      "uv",
      ["venv", "--quiet", "--python", PYTHON_VERSION, dir],
      {
        stdio: "pipe",
      },
    );
    if (r.status !== 0) {
      const err = r.stderr?.toString() ?? "";
      throw new Error(
        `failed to create pi-eval venv at ${dir}: ${err || `exit ${r.status}`} (is \`uv\` installed?)`,
      );
    }
  }
  cachedVenv = { dir, python };
  return cachedVenv;
}

export interface PyKernelOptions {
  bridgeUrl: string;
  bridgeToken: string;
  bridgeSession: string;
  cwd?: string;
  python?: string;
}

export class PyKernel {
  #proc: ChildProcess;
  #pending = new Map<string, PendingRun>();
  #eventBuf = "";
  #closed = false;
  #ready: Promise<void>;

  constructor(opts: PyKernelOptions) {
    const runnerPath = path.join(import.meta.dirname, "runner.py");
    const venv = ensureVenv();
    const python = opts.python ?? venv.python;
    this.#proc = spawn(python, ["-u", runnerPath], {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PI_EVAL_BRIDGE_URL: opts.bridgeUrl,
        PI_EVAL_BRIDGE_TOKEN: opts.bridgeToken,
        PI_EVAL_BRIDGE_SESSION: opts.bridgeSession,
        PI_EVAL_VENV_PYTHON: venv.python,
        VIRTUAL_ENV: venv.dir,
      },
    });

    const eventStream = this.#proc.stdio[3] as NodeJS.ReadableStream | null;
    if (!eventStream) throw new Error("python kernel: fd 3 unavailable");
    eventStream.setEncoding?.("utf-8");
    eventStream.on("data", (chunk: string) => this.#onEventChunk(chunk));
    this.#proc.unref();
    (this.#proc.stdin as { unref?: () => void } | null)?.unref?.();
    (this.#proc.stdout as { unref?: () => void } | null)?.unref?.();
    (this.#proc.stderr as { unref?: () => void } | null)?.unref?.();
    (eventStream as { unref?: () => void }).unref?.();

    this.#proc.stdin?.on("error", () => {});
    this.#proc.stdout?.resume();
    this.#proc.stderr?.setEncoding("utf-8");
    this.#proc.stderr?.on("data", (s) =>
      process.stderr.write(`[py-kernel] ${s}`),
    );

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#proc.once("spawn", resolve);
      this.#proc.once("error", (err) => {
        this.#closed = true;
        reject(err);
        for (const pending of this.#pending.values()) {
          pending.result.error ??= `python kernel failed: ${err.message}`;
          this.#finalize(pending);
        }
        this.#pending.clear();
      });
      this.#proc.once("exit", (code, signal) => {
        this.#closed = true;
        const reason = code === null ? `signal ${signal}` : `code ${code}`;
        for (const pending of this.#pending.values()) {
          pending.result.error ??= `python kernel exited with ${reason} mid-run`;
          this.#finalize(pending);
        }
        this.#pending.clear();
      });
    });
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  get alive(): boolean {
    return !this.#closed;
  }

  async run(
    code: string,
    timeoutSec: number,
    title: string | undefined,
    onProgress?: (r: CellResult) => void,
    signal?: AbortSignal,
  ): Promise<CellResult> {
    const result: CellResult = {
      title,
      stdout: "",
      stderr: "",
      value: null,
      error: null,
      displays: [],
      durationMs: 0,
    };
    if (signal?.aborted) {
      result.aborted = true;
      result.error = "cell aborted before start";
      return result;
    }
    if (this.#closed) throw new Error("python kernel has exited");

    const id = randomUUID();
    return new Promise<CellResult>((resolve) => {
      const pending: PendingRun = {
        id,
        resolve,
        result,
        startedAt: Date.now(),
        timeoutSec,
        timeout: null,
        escalation: null,
        interruptReason: null,
        onProgress,
        signal,
      };
      const abort = () => this.#interrupt(pending, "aborted");
      pending.onAbort = abort;
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, pending);
      pending.timeout = setTimeout(
        () => this.#interrupt(pending, "timedOut"),
        timeoutSec * 1000,
      );
      this.#send({ id, op: "run", code });
    });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#proc.kill("SIGTERM");
    } catch {}
  }

  #interrupt(pending: PendingRun, reason: "aborted" | "timedOut"): void {
    if (pending.interruptReason) return;
    pending.interruptReason = reason;
    try {
      this.#proc.kill("SIGINT");
    } catch {}
    pending.escalation = setTimeout(() => {
      const label =
        reason === "aborted"
          ? "aborted"
          : `timed out after ${pending.timeoutSec}s`;
      pending.result[reason === "aborted" ? "aborted" : "timedOut"] = true;
      pending.result.error =
        pending.result.error ??
        `cell ${label} (interrupt ignored; kernel killed, state lost)`;
      this.#pending.delete(pending.id);
      this.dispose();
      this.#finalize(pending);
    }, INTERRUPT_GRACE_MS);
  }

  #send(req: KernelRequest): void {
    const line = JSON.stringify(req) + "\n";
    try {
      if (!this.#proc.stdin) throw new Error("kernel stdin unavailable");
      this.#proc.stdin.write(line);
    } catch (err) {
      this.#closed = true;
      const pending = this.#pending.get(req.id);
      if (pending) {
        this.#pending.delete(req.id);
        pending.result.error ??= `python kernel write failed: ${err instanceof Error ? err.message : String(err)}`;
        this.#finalize(pending);
      }
    }
  }

  #onEventChunk(chunk: string): void {
    this.#eventBuf += chunk;
    let nl: number;
    while ((nl = this.#eventBuf.indexOf("\n")) >= 0) {
      const line = this.#eventBuf.slice(0, nl);
      this.#eventBuf = this.#eventBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let event: KernelEvent;
      try {
        event = JSON.parse(line) as KernelEvent;
      } catch {
        continue;
      }
      this.#onEvent(event);
    }
  }

  #onEvent(event: KernelEvent): void {
    const pending = this.#pending.get(event.id);
    if (!pending) return;
    switch (event.op) {
      case "stream":
        if (event.stream === "stdout") pending.result.stdout += event.text;
        else pending.result.stderr += event.text;
        try {
          pending.onProgress?.(pending.result);
        } catch {}
        break;
      case "display":
        pending.result.displays.push({
          mime: event.mime,
          data: event.data,
        } satisfies DisplayItem);
        try {
          pending.onProgress?.(pending.result);
        } catch {}
        break;
      case "done":
        pending.result.value = event.value;
        if (event.error) pending.result.error = event.error;
        if (pending.interruptReason === "timedOut") {
          pending.result.timedOut = true;
          pending.result.error = `cell timed out after ${pending.timeoutSec}s (interrupted; kernel state preserved)`;
        } else if (pending.interruptReason === "aborted") {
          pending.result.aborted = true;
          pending.result.error =
            "cell aborted (interrupted; kernel state preserved)";
        }
        this.#pending.delete(event.id);
        this.#finalize(pending);
        break;
    }
  }

  #finalize(pending: PendingRun): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.escalation) clearTimeout(pending.escalation);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    pending.result.durationMs = Date.now() - pending.startedAt;
    pending.resolve(pending.result);
  }
}
