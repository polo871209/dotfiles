// Persistent nvim instances, one per lane. Lazy spawn on first use, --embed
// over stdio (msgpack-rpc via `neovim` npm pkg). Crash-resilient: on child
// exit, clear the lane so its next call respawns.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attach, type NeovimClient } from "neovim";

const DRIVER_PATH = path.join(import.meta.dirname, "driver.lua");
const LOG_FILE = path.join(os.tmpdir(), "pi-lsp.log");

const log = (msg: string) => {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8",
    );
  } catch {
    /* best effort */
  }
};

type ProgressFn = (text: string) => void;

interface NvimSession {
  proc: ChildProcess;
  client: NeovimClient;
}

// Two independent nvim instances. A single nvim can't run two lua chunks
// concurrently (vim.wait pumps the loop -> shared-state corruption), so the
// queue below serializes each lane. "main" carries nav tools + the heavy
// turn-end diagnostics pass; "inline" is dedicated to fast format-on-edit so
// it never queues behind a long background run (the old "stuck after edit").
export type Lane = "main" | "inline";
const LANES: Lane[] = ["main", "inline"];

const sessions: Record<Lane, NvimSession | null> = { main: null, inline: null };
const startings: Record<Lane, Promise<NvimSession> | null> = {
  main: null,
  inline: null,
};

const spawnNvim = async (
  lane: Lane,
  cwd: string,
  onProgress: ProgressFn | undefined,
): Promise<NvimSession> => {
  onProgress?.("starting nvim…");
  // pi_agent flag (set pre-config via --cmd) lets the nvim config skip purely
  // cosmetic plugins headless, keeping only LSP/format/lint. Faster warm-spawn,
  // identical servers/rules. See plugin/*.lua guards.
  const proc = spawn(
    "nvim",
    ["--embed", "--headless", "--cmd", "lua vim.g.pi_agent=true"],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    },
  );

  proc.on("exit", (code, signal) => {
    log(`nvim[${lane}] exited code=${code} signal=${signal}`);
    sessions[lane] = null;
  });
  proc.on("error", (err) => {
    log(`nvim[${lane}] spawn error: ${err.message}`);
    sessions[lane] = null;
  });
  proc.stderr?.on("data", (b: Buffer) => {
    const s = b.toString().trim();
    if (s) log(`stderr: ${s}`);
  });

  const client = attach({ proc });

  // Load driver source as a string — avoids path-quoting in Lua.
  onProgress?.("loading lsp driver…");
  let driverSrc: string;
  try {
    driverSrc = fs.readFileSync(DRIVER_PATH, "utf8");
  } catch (e) {
    proc.kill("SIGTERM");
    throw new Error(
      `lsp driver not readable at ${DRIVER_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await client.lua(driverSrc, []);
  onProgress?.("nvim ready");
  return { proc, client };
};

const getNvim = async (
  lane: Lane,
  cwd: string,
  onProgress?: ProgressFn,
): Promise<NeovimClient> => {
  const cur = sessions[lane];
  if (cur) return cur.client;
  const inflight = startings[lane];
  if (inflight) return (await inflight).client;
  const p = spawnNvim(lane, cwd, onProgress).catch((e) => {
    startings[lane] = null;
    throw e;
  });
  startings[lane] = p;
  try {
    sessions[lane] = await p;
    return sessions[lane]!.client;
  } finally {
    startings[lane] = null;
  }
};

const shutdownLane = (lane: Lane): void => {
  const session = sessions[lane];
  if (!session) return;
  const { proc } = session;
  sessions[lane] = null;
  // proc.killed only means a signal was sent, not that the process died.
  // Track real exit so the SIGKILL fallback actually fires on a nvim that
  // ignores SIGTERM (headless --embed can linger) -> no orphans.
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  try {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }, 1000).unref();
  } catch {
    /* ignore */
  }
};

export const shutdownNvim = (): void => {
  for (const lane of LANES) shutdownLane(lane);
};

export const isRunning = (lane: Lane = "main"): boolean =>
  sessions[lane] !== null;

// Serialize lua chunks per lane: `vim.wait` pumps the event loop and can run a
// second chunk mid-call, mutating shared buffer state. Chain each after the
// last, independently per nvim instance.
const queueTails: Record<Lane, Promise<unknown>> = {
  main: Promise.resolve(),
  inline: Promise.resolve(),
};
const noop = () => {};
const enqueue = <T>(lane: Lane, task: () => Promise<T>): Promise<T> => {
  const run = queueTails[lane].then(task, task);
  queueTails[lane] = run.then(noop, noop);
  return run;
};

// Run arbitrary Lua in the persistent nvim, racing against an abort signal.
// Code should `return` a JSON-safe value (table, string, number, bool, nil).
export const callLua = async <T = unknown>(
  cwd: string,
  code: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
  lane: Lane = "main",
): Promise<T> => {
  const client = await getNvim(lane, cwd, onProgress);
  if (signal?.aborted) throw new Error("aborted");
  const exec = enqueue(lane, () => client.lua(code, args as never) as Promise<T>);
  if (!signal) return exec;
  // Abort just stops awaiting: the queued lua can't be cancelled and runs to
  // completion in nvim (bounded by lua-side budgets).
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    exec.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
};

// Hard cap on a single nav/diagnostics driver call. Lua-side budgets bound
// each op (attach 2.5s + progress 8s + per-file pulls), but a wedged nvim or
// a server that never returns would otherwise hang the tool forever, since
// callLua's abort only stops awaiting. Scale by file count so a cold
// multi-file diagnostics pass isn't cut short; the signal fires only on a
// real wedge.
const DRIVER_CAP_BASE_MS = 15_000;
const DRIVER_CAP_PER_FILE_MS = 8_000;

// Sugar: call _G.PiLsp.<fn>(args...) for navigation tools.
export const callDriver = <T = unknown>(
  cwd: string,
  fn: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
): Promise<T> => {
  const fileCount = Array.isArray(args[0]) ? Math.max(1, args[0].length) : 1;
  const timeoutSignal = AbortSignal.timeout(
    DRIVER_CAP_BASE_MS + fileCount * DRIVER_CAP_PER_FILE_MS,
  );
  const combined = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return callLua<T>(cwd, `return PiLsp.${fn}(...)`, args, combined, onProgress);
};

// Load a Lua module source into the persistent nvim once per session.
// Caller tracks its own loaded flag.
export const loadLua = async (
  cwd: string,
  src: string,
  lane: Lane = "main",
): Promise<void> => {
  const client = await getNvim(lane, cwd);
  await client.lua(src, []);
};
