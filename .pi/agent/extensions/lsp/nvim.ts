// Persistent nvim singleton. Lazy spawn on first use, --embed over stdio
// (msgpack-rpc via `neovim` npm pkg). Crash-resilient: on child exit, clear
// singleton so next call respawns.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { attach, type NeovimClient } from "neovim";

const _here =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = path.join(_here, "driver.lua");
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

let session: NvimSession | null = null;
let starting: Promise<NvimSession> | null = null;

const spawnNvim = async (
  cwd: string,
  onProgress: ProgressFn | undefined,
): Promise<NvimSession> => {
  onProgress?.("starting nvim…");
  const proc = spawn("nvim", ["--embed", "--headless"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  proc.on("exit", (code, signal) => {
    log(`nvim exited code=${code} signal=${signal}`);
    session = null;
  });
  proc.on("error", (err) => {
    log(`nvim spawn error: ${err.message}`);
    session = null;
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
  cwd: string,
  onProgress?: ProgressFn,
): Promise<NeovimClient> => {
  if (session) return session.client;
  if (starting) return (await starting).client;
  starting = spawnNvim(cwd, onProgress).catch((e) => {
    starting = null;
    throw e;
  });
  try {
    session = await starting;
    return session.client;
  } finally {
    starting = null;
  }
};

export const shutdownNvim = (): void => {
  if (!session) return;
  const { proc } = session;
  session = null;
  try {
    proc.kill("SIGTERM");
    // Force-kill if it lingers.
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1000).unref();
  } catch {
    /* ignore */
  }
};

export const isRunning = (): boolean => session !== null;

// Run arbitrary Lua in the persistent nvim, racing against an abort signal.
// Code should `return` a JSON-safe value (table, string, number, bool, nil).
export const callLua = async <T = unknown>(
  cwd: string,
  code: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
): Promise<T> => {
  const client = await getNvim(cwd, onProgress);
  const call = client.lua(code, args as never) as Promise<T>;
  if (!signal) return call;
  if (signal.aborted) throw new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
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

// Sugar: call _G.PiLsp.<fn>(args...) for navigation tools.
export const callDriver = <T = unknown>(
  cwd: string,
  fn: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
): Promise<T> =>
  callLua<T>(cwd, `return PiLsp.${fn}(...)`, args, signal, onProgress);

// Load a Lua module source into the persistent nvim once per session.
// Caller tracks its own loaded flag.
export const loadLua = async (cwd: string, src: string): Promise<void> => {
  const client = await getNvim(cwd);
  await client.lua(src, []);
};
