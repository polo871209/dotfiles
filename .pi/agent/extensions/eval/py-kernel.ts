// Long-lived Python kernel: spawn `python3 runner.py`, multiplex requests over
// stdin (JSON lines) and events over a third pipe (fd 3).
//
// User stdout/stderr from runner are forwarded as `stream` events on fd 3, so
// stdout of the child process itself is unused (kept piped & ignored).

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
  resolve: (r: CellResult) => void;
  result: CellResult;
  startedAt: number;
  timeout: NodeJS.Timeout | null;
  onProgress?: (r: CellResult) => void;
}

interface VenvInfo {
  dir: string;
  python: string;
}

let cachedVenv: VenvInfo | null = null;

function ensureVenv(): VenvInfo {
  if (cachedVenv) return cachedVenv;
  const dir = path.join(os.homedir(), ".cache", "pi-eval", "venv");
  const python = path.join(dir, "bin", "python");
  if (!fs.existsSync(python)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = spawnSync("uv", ["venv", "--quiet", "--python", "3.14", dir], {
      stdio: "pipe",
    });
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
  python?: string;
}

export class PyKernel {
  #proc: ChildProcess;
  #pending = new Map<string, PendingRun>();
  #pendingResets = new Map<string, () => void>();
  #eventBuf = "";
  #closed = false;
  #ready: Promise<void>;

  constructor(opts: PyKernelOptions) {
    const runnerPath = path.join(import.meta.dirname, "runner.py");
    const venv = ensureVenv();
    const python = opts.python ?? venv.python;
    this.#proc = spawn(python, ["-u", runnerPath], {
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

    // fd 3 is the kernel event channel.
    const eventStream = this.#proc.stdio[3] as NodeJS.ReadableStream | null;
    if (!eventStream) throw new Error("python kernel: fd 3 unavailable");
    eventStream.setEncoding?.("utf-8");
    eventStream.on("data", (chunk: string) => this.#onEventChunk(chunk));
    // Unref process + every pipe so tests/standalone hosts can exit when work
    // settles; pi keeps its own refs to this kernel object.
    this.#proc.unref();
    (this.#proc.stdin as { unref?: () => void } | null)?.unref?.();
    (this.#proc.stdout as { unref?: () => void } | null)?.unref?.();
    (this.#proc.stderr as { unref?: () => void } | null)?.unref?.();
    (eventStream as { unref?: () => void }).unref?.();

    // Broken pipe on stdin (kernel died between an alive check and a write)
    // emits 'error'; without a listener Node turns it into a process-wide
    // uncaughtException. Swallow it — the exit handler does the real cleanup.
    this.#proc.stdin?.on("error", () => {});
    // Discard child stdout (user code redirects to fd 3 anyway); surface stderr
    // to the host stderr for boot diagnostics.
    this.#proc.stdout?.resume();
    this.#proc.stderr?.setEncoding("utf-8");
    this.#proc.stderr?.on("data", (s) =>
      process.stderr.write(`[py-kernel] ${s}`),
    );

    this.#ready = new Promise<void>((resolve, reject) => {
      // No explicit hello; the runner is ready as soon as it starts reading
      // stdin. Resolve next tick.
      queueMicrotask(resolve);
      this.#proc.once("error", (err) => {
        this.#closed = true;
        reject(err);
      });
      this.#proc.once("exit", (code) => {
        this.#closed = true;
        for (const pending of this.#pending.values()) {
          pending.result.error =
            pending.result.error ??
            `python kernel exited with code ${code} mid-run`;
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
  ): Promise<CellResult> {
    if (this.#closed) throw new Error("python kernel has exited");
    const id = randomUUID();
    return new Promise<CellResult>((resolve) => {
      const result: CellResult = {
        title,
        language: "py",
        stdout: "",
        stderr: "",
        value: null,
        error: null,
        displays: [],
        durationMs: 0,
      };
      const pending: PendingRun = {
        resolve,
        result,
        startedAt: Date.now(),
        timeout: null,
        onProgress,
      };
      pending.timeout = setTimeout(() => {
        result.timedOut = true;
        result.error = result.error ?? `cell timed out after ${timeoutSec}s`;
        // Remove before dispose: dispose's exit handler re-walks #pending and
        // would double-finalize this entry otherwise.
        this.#pending.delete(id);
        // Kill the kernel; state is lost, but we cannot interrupt cleanly
        // without an IPython-style control channel. Caller spawns a fresh one.
        this.dispose();
        this.#finalize(pending);
      }, timeoutSec * 1000);
      this.#pending.set(id, pending);
      this.#send({ id, op: "run", code, timeout: timeoutSec });
    });
  }

  async reset(): Promise<void> {
    if (this.#closed) return;
    const id = randomUUID();
    await new Promise<void>((resolve) => {
      this.#pendingResets.set(id, resolve);
      this.#send({ id, op: "reset" });
    });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#proc.kill("SIGTERM");
    } catch {}
  }

  #send(req: KernelRequest): void {
    const line = JSON.stringify(req) + "\n";
    try {
      this.#proc.stdin?.write(line);
    } catch (err) {
      // Kernel died between the alive check and this write. Finalize the
      // matching pending so the caller gets an error result instead of a hung
      // promise; mark closed so the next run respawns.
      this.#closed = true;
      const msg = `python kernel write failed: ${err instanceof Error ? err.message : String(err)}`;
      const pending = this.#pending.get(req.id);
      if (pending) {
        this.#pending.delete(req.id);
        pending.result.error = pending.result.error ?? msg;
        this.#finalize(pending);
      }
      this.#pendingResets.get(req.id)?.();
      this.#pendingResets.delete(req.id);
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
    if (event.op === "done") {
      const resetResolve = this.#pendingResets.get(event.id);
      if (resetResolve) {
        this.#pendingResets.delete(event.id);
        resetResolve();
        return;
      }
    }
    const pending = this.#pending.get(event.id);
    if (!pending) return;
    switch (event.op) {
      case "stream":
        if (event.stream === "stdout") pending.result.stdout += event.text;
        else pending.result.stderr += event.text;
        pending.onProgress?.(pending.result);
        break;
      case "display":
        pending.result.displays.push({
          mime: event.mime,
          data: event.data,
        } satisfies DisplayItem);
        pending.onProgress?.(pending.result);
        break;
      case "done":
        pending.result.value = event.value;
        if (event.error) pending.result.error = event.error;
        this.#finalize(pending);
        this.#pending.delete(event.id);
        break;
    }
  }

  #finalize(pending: PendingRun): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.result.durationMs = Date.now() - pending.startedAt;
    pending.resolve(pending.result);
  }
}
