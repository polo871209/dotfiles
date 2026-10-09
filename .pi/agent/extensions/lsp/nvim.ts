import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { attach, type NeovimClient } from "neovim";
import { surviveReload } from "../shared/reload";

const DRIVER_PATH = path.join(import.meta.dirname, "driver.lua");
const LOG_FILE = path.join(os.tmpdir(), "pi-lsp.log");

// Derive from $HOME only. Any env input (TMPDIR, XDG_RUNTIME_DIR) can differ
// between processes and split the daemon pool. Keep it short: unix socket
// paths cap around 104 bytes.
const RUNTIME_DIR = path.join(os.homedir(), ".cache", "pi-lsp");

const log = (msg: string) => {
  try {
    if (fs.statSync(LOG_FILE).mtimeMs < Date.now() - 24 * 60 * 60 * 1000)
      fs.rmSync(LOG_FILE, { force: true });
  } catch {}
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8",
    );
  } catch {}
};

type ProgressFn = (text: string) => void;

interface NvimSession {
  socket: net.Socket;
  client: NeovimClient;
  epoch: string;
  dead: boolean;
}

export type Lane = "main" | "inline";
const LANES: Lane[] = ["main", "inline"];

const sessions: Record<Lane, NvimSession | null> = { main: null, inline: null };
const startings: Record<Lane, Promise<NvimSession> | null> = {
  main: null,
  inline: null,
};
const laneAborts: Record<Lane, AbortController> = {
  main: new AbortController(),
  inline: new AbortController(),
};

const socketPath = (lane: Lane) => path.join(RUNTIME_DIR, `${lane}.sock`);
const lockPath = (lane: Lane) => path.join(RUNTIME_DIR, `${lane}.lock`);
surviveReload("__piLspExitHook", () => {
  const hook: { disconnect?: () => void } = {};
  process.on("exit", () => {
    try {
      hook.disconnect?.();
    } catch {}
  });
  return hook;
}).disconnect = () => disconnectNvim();

const connect = (lane: Lane): Promise<net.Socket | null> =>
  new Promise((resolve) => {
    const socket = net.connect(socketPath(lane));
    const settle = (ok: boolean) => {
      socket.removeAllListeners("connect");
      socket.removeAllListeners("error");
      socket.setTimeout(0);
      if (ok) resolve(socket);
      else {
        socket.destroy();
        resolve(null);
      }
    };
    socket.setTimeout(2_000, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

const openSession = async (
  lane: Lane,
  socket: net.Socket,
): Promise<NvimSession> => {
  const client = attach({ reader: socket, writer: socket });
  client.setClientInfo(
    "pi-lsp",
    {},
    "remote",
    {},
    {
      pid: String(process.pid),
      lane,
    },
  );
  const session: NvimSession = {
    socket,
    client,
    epoch: String(await client.lua("return vim.g.pi_daemon_epoch", [])),
    dead: false,
  };
  const drop = () => {
    session.dead = true;
    if (sessions[lane] === session) {
      sessions[lane] = null;
      laneAborts[lane].abort(new Error(`nvim[${lane}] disconnected`));
      laneAborts[lane] = new AbortController();
    }
  };
  socket.once("close", drop);
  socket.once("error", (e) => {
    log(`nvim[${lane}] socket error: ${e.message}`);
    drop();
  });
  return session;
};

const takeSpawnLock = (lane: Lane): boolean => {
  try {
    fs.mkdirSync(lockPath(lane));
    return true;
  } catch {
    try {
      if (Date.now() - fs.statSync(lockPath(lane)).mtimeMs < 60_000)
        return false;
      fs.rmSync(lockPath(lane), { recursive: true, force: true });
      fs.mkdirSync(lockPath(lane));
      return true;
    } catch {
      return false;
    }
  }
};

const spawnDaemon = (lane: Lane, cwd: string): void => {
  try {
    fs.rmSync(socketPath(lane), { force: true });
  } catch {}
  const proc = spawn(
    "nvim",
    [
      "--headless",
      "--listen",
      socketPath(lane),
      "--cmd",
      `luafile ${path.join(import.meta.dirname, "daemon.lua").replace(/ /g, "\\ ")}`,
    ],
    { cwd, detached: true, stdio: "ignore", env: process.env },
  );
  proc.unref();
  log(`nvim[${lane}] daemon spawned pid=${proc.pid}`);
};

const waitForDaemon = async (lane: Lane): Promise<net.Socket | null> => {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const socket = await connect(lane);
    if (socket) return socket;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

const acquire = async (
  lane: Lane,
  cwd: string,
  onProgress: ProgressFn | undefined,
): Promise<NvimSession> => {
  let socket = await connect(lane);
  if (!socket) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    onProgress?.("starting nvim daemon…");
    if (takeSpawnLock(lane)) {
      try {
        spawnDaemon(lane, cwd);
        socket = await waitForDaemon(lane);
      } finally {
        fs.rmSync(lockPath(lane), { recursive: true, force: true });
      }
    } else {
      socket = await waitForDaemon(lane);
    }
  }
  if (!socket) throw new Error(`nvim[${lane}] daemon did not come up`);
  onProgress?.("nvim ready");
  return openSession(lane, socket);
};

const getSession = async (
  lane: Lane,
  cwd: string,
  onProgress?: ProgressFn,
): Promise<NvimSession> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = sessions[lane];
    if (cur && !cur.dead) return cur;
    if (cur?.dead) sessions[lane] = null;
    const inflight = startings[lane];
    if (inflight) {
      const session = await inflight;
      if (!session.dead) return session;
      continue;
    }
    const p = acquire(lane, cwd, onProgress).catch((e) => {
      startings[lane] = null;
      throw e;
    });
    startings[lane] = p;
    let session: NvimSession;
    try {
      session = await p;
    } finally {
      startings[lane] = null;
    }
    if (session.dead) continue;
    sessions[lane] = session;
    return session;
  }
  throw new Error(`nvim[${lane}] daemon closed the connection twice`);
};

const dropLane = (lane: Lane): void => {
  const session = sessions[lane];
  if (!session) return;
  sessions[lane] = null;
  laneAborts[lane].abort(new Error(`nvim[${lane}] disconnected`));
  laneAborts[lane] = new AbortController();
  try {
    // end(), not destroy(): the msgpack decoder the client wraps around this
    // socket rejects with ERR_STREAM_PREMATURE_CLOSE on an abrupt teardown,
    // and nothing in the library catches it — an unhandled rejection that
    // takes the whole pi process down on shutdown. A FIN reads as clean EOF.
    session.socket.end();
    setTimeout(() => session.socket.destroy(), 500).unref();
  } catch {}
};

export const disconnectNvim = (): void => {
  for (const lane of LANES) dropLane(lane);
};

const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      p.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const restartDaemons = async (): Promise<boolean> => {
  let killed = false;
  for (const lane of LANES) {
    let client = sessions[lane]?.client ?? null;
    const adhoc = client ? null : await connect(lane);
    if (adhoc) client = attach({ reader: adhoc, writer: adhoc });
    if (!client) continue;
    killed = true;
    const pid = (await withTimeout(
      client.lua("return vim.uv.os_getpid()", []),
      1_000,
    )) as number | null;
    await withTimeout(client.command("qall!"), 500);
    dropLane(lane);
    adhoc?.end();
    if (pid) {
      for (let i = 0; i < 20 && alive(pid); i++)
        await new Promise((r) => setTimeout(r, 100));
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
  return killed;
};

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

const guarded = (code: string) => `
local f = function(...)
${code}
end
if _G.PiDaemon then return PiDaemon.guard(f, ...) end
return f(...)`;

const isBusy = (res: unknown): boolean =>
  typeof res === "object" && res !== null && "__pi_busy" in res;

const callGuarded = async <T>(
  client: NeovimClient,
  code: string,
  args: unknown[],
  aborted: () => boolean,
): Promise<T> => {
  for (;;) {
    if (aborted()) throw new Error("aborted");
    const res = await client.lua(guarded(code), args as never);
    if (!isBusy(res)) return res as T;
    await new Promise((r) => setTimeout(r, 40));
  }
};

// Run arbitrary Lua in the shared nvim, racing against an abort signal.
// Code should `return` a JSON-safe value (table, string, number, bool, nil).
export const callLua = async <T = unknown>(
  cwd: string,
  code: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
  lane: Lane = "main",
): Promise<T> => {
  const { client } = await getSession(lane, cwd, onProgress);
  const combined = signal
    ? AbortSignal.any([signal, laneAborts[lane].signal])
    : laneAborts[lane].signal;
  if (combined.aborted) throw new Error("aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      combined.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    combined.addEventListener("abort", onAbort, { once: true });
    enqueue(lane, () => {
      if (combined.aborted) throw new Error("aborted");
      return callGuarded<T>(client, code, args, () => combined.aborted);
    }).then(
      (v) => {
        combined.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        combined.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
};

export const callDriver = async <T = unknown>(
  cwd: string,
  fn: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
): Promise<T> => {
  await ensureDriverLoaded(cwd, onProgress);
  const timeoutSignal = AbortSignal.timeout(
    15_000 + (Array.isArray(args[0]) ? Math.max(1, args[0].length) : 1) * 8_000,
  );
  return callLua<T>(
    cwd,
    `return PiLsp.${fn}(...)`,
    args,
    signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    onProgress,
  );
};

const loadedHere = new Set<string>();
const digest = (src: string) =>
  crypto.createHash("sha1").update(src).digest("hex").slice(0, 16);

export const loadLuaOnce = async (
  cwd: string,
  key: string,
  src: string,
  lane: Lane = "main",
): Promise<void> => {
  const { client, epoch } = await getSession(lane, cwd);
  const hash = digest(src);
  const cacheKey = `${lane}:${epoch}:${key}:${hash}`;
  if (loadedHere.has(cacheKey)) return;
  const flag = `pi_lua_${key}`;
  if ((await client.lua(`return vim.g[...]`, [flag] as never)) !== hash) {
    const deadline = AbortSignal.timeout(20_000);
    await callGuarded(client, src, [], () => deadline.aborted);
    await client.lua(`local k, v = ...; vim.g[k] = v`, [flag, hash] as never);
  }
  loadedHere.add(cacheKey);
};

let driverSrc: { mtimeMs: number; src: string } | null = null;
const ensureDriverLoaded = async (
  cwd: string,
  onProgress?: ProgressFn,
): Promise<void> => {
  const mtimeMs = fs.statSync(DRIVER_PATH).mtimeMs;
  if (driverSrc?.mtimeMs !== mtimeMs) {
    driverSrc = { mtimeMs, src: fs.readFileSync(DRIVER_PATH, "utf8") };
    onProgress?.("loading lsp driver…");
  }
  await loadLuaOnce(cwd, "driver", driverSrc.src, "main");
};

interface DaemonInfo {
  pid: number;
  epoch: string;
  uptime_s: number;
  clients: number;
  client_pids: number[];
  rss_mb: number;
  busy: boolean;
}
export const daemonInfo = async (
  cwd: string,
  lane: Lane = "main",
): Promise<DaemonInfo | null> => {
  const { client } = await getSession(lane, cwd);
  try {
    return (await client.lua(
      "return _G.PiDaemon and PiDaemon.info()",
      [],
    )) as DaemonInfo | null;
  } catch {
    return null;
  }
};
