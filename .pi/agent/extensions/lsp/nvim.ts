// Client for the shared nvim daemons: connect to a lane's unix socket, spawn a
// detached `nvim --headless --listen` only if nobody has yet, and leave it
// running for the next process (it reaps itself — daemon.lua). What sharing one
// editor across pi processes constrains is in AGENTS.md.
//
// A fresh subagent therefore attaches to servers that are already warm, which
// is the expensive part of a first hover on a large project.

import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { attach, type NeovimClient } from "neovim";

const DRIVER_PATH = path.join(import.meta.dirname, "driver.lua");
const DAEMON_PATH = path.join(import.meta.dirname, "daemon.lua");
const LOG_FILE = path.join(os.tmpdir(), "pi-lsp.log");
const LOG_TTL_MS = 24 * 60 * 60 * 1000;

// Every process has to derive the same path or the whole design silently
// degrades into one daemon per disagreeing process. So: no env in here. Not
// os.tmpdir() (TMPDIR differs between a terminal and a launchd-spawned process
// on macOS) and not XDG_RUNTIME_DIR either, however conventional — one pane
// exporting it and the next not is enough to split the pool. Keep it short too:
// unix socket paths cap around 104 bytes.
const RUNTIME_DIR = path.join(os.homedir(), ".cache", "pi-lsp");

const CONNECT_TIMEOUT_MS = 2_000;
const SPAWN_TIMEOUT_MS = 25_000;
const SPAWN_POLL_MS = 100;
// Backoff after the daemon bounces us because a peer process holds the guard.
const BUSY_RETRY_MS = 40;
// Ceiling on that retry loop for module loads. Every other path into the
// daemon inherits a caller deadline, but loads run ahead of one — callDriver
// arms its cap after the driver is in place — so without this a peer holding
// the guard would stall a nav call for as long as it held it.
const LOAD_TIMEOUT_MS = 20_000;
// A spawn lock older than this belonged to a process that died mid-spawn.
const LOCK_STALE_MS = 60_000;

// Crash-diagnostic scratch, useful for hours not weeks: a day-old file is
// dropped rather than appended to, so it can't grow across months of sessions.
const log = (msg: string) => {
  try {
    const stale = fs.statSync(LOG_FILE).mtimeMs < Date.now() - LOG_TTL_MS;
    if (stale) fs.rmSync(LOG_FILE, { force: true });
  } catch {
    /* no log yet */
  }
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
  socket: net.Socket;
  client: NeovimClient;
  // Daemon identity, not a local counter: two pi processes talking to the same
  // daemon must agree on whether its lua is already loaded.
  epoch: string;
  // Set the moment this socket closes. Carried on the session rather than
  // inferred from `sessions[lane]`, because the close can land before the
  // session is ever installed there — a peer's /lsp-restart during our connect
  // would otherwise leave a dead socket cached and every later call failing.
  dead: boolean;
}

// Two daemons, not one. A single nvim can't run two lua chunks concurrently
// (vim.wait pumps the loop -> shared-state corruption), so "main" carries nav
// tools plus the heavy turn-end diagnostics pass while "inline" is dedicated
// to fast format-on-edit and never queues behind a long background run.
export type Lane = "main" | "inline";
const LANES: Lane[] = ["main", "inline"];

const sessions: Record<Lane, NvimSession | null> = { main: null, inline: null };
const startings: Record<Lane, Promise<NvimSession> | null> = {
  main: null,
  inline: null,
};
// Per-lane abort fanned out to in-flight callLua promises on disconnect — the
// RPC channel closing is not guaranteed to reject pending requests, and a
// hanging promise here hangs the awaiting tool call forever.
const laneAborts: Record<Lane, AbortController> = {
  main: new AbortController(),
  inline: new AbortController(),
};

const socketPath = (lane: Lane) => path.join(RUNTIME_DIR, `${lane}.sock`);
const lockPath = (lane: Lane) => path.join(RUNTIME_DIR, `${lane}.lock`);

// Detach our end of the socket on abrupt host death (unhandled throw) so the
// daemon's client count drops and its idle timer can start. Guarded on
// globalThis: hot reload builds a fresh module graph and would otherwise stack
// a listener per reload.
if (!(globalThis as Record<string, unknown>).__piLspExitHook) {
  (globalThis as Record<string, unknown>).__piLspExitHook = true;
  process.on("exit", () => {
    try {
      disconnectNvim();
    } catch {
      /* ignore */
    }
  });
}

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
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

const openSession = async (
  lane: Lane,
  socket: net.Socket,
): Promise<NvimSession> => {
  const client = attach({ reader: socket, writer: socket });
  // Tell the daemon whose channel this is. Its client count gates the idle
  // exit, so a channel it can't attribute is a channel it can't reclaim: a
  // peer that died without a clean close would otherwise keep the daemon (and
  // every language server under it) alive forever.
  // Fire-and-forget by design (the API returns void), but written to the
  // transport before the next request, so the daemon has it in hand.
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
  const epoch = String(await client.lua("return vim.g.pi_daemon_epoch", []));
  const session: NvimSession = { socket, client, epoch, dead: false };
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
      const age = Date.now() - fs.statSync(lockPath(lane)).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      fs.rmSync(lockPath(lane), { recursive: true, force: true });
      fs.mkdirSync(lockPath(lane));
      return true;
    } catch {
      return false;
    }
  }
};

const spawnDaemon = (lane: Lane, cwd: string): void => {
  // A socket file left by a daemon that died hard blocks --listen.
  try {
    fs.rmSync(socketPath(lane), { force: true });
  } catch {
    /* ignore */
  }
  const proc = spawn(
    "nvim",
    [
      "--headless",
      "--listen",
      socketPath(lane),
      "--cmd",
      `luafile ${DAEMON_PATH.replace(/ /g, "\\ ")}`,
    ],
    { cwd, detached: true, stdio: "ignore", env: process.env },
  );
  // Outliving this pi process is the point: no unref/kill handles kept.
  proc.unref();
  log(`nvim[${lane}] daemon spawned pid=${proc.pid}`);
};

const waitForDaemon = async (lane: Lane): Promise<net.Socket | null> => {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const socket = await connect(lane);
    if (socket) return socket;
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
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
    // Lock loser doesn't spawn a competing daemon, it waits for the winner's.
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

// Two attempts, because a daemon dying mid-connect is normal here: any peer
// process can /lsp-restart at any time, and that shouldn't surface as a failed
// hover when a reconnect would just work.
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
  } catch {
    /* ignore */
  }
};

// Session teardown: drop our end of the socket only. The daemon is shared, so
// killing it here would yank the LSP out from under every other pi process;
// it exits on its own once the last client leaves (IDLE_EXIT_MS in daemon.lua).
export const disconnectNvim = (): void => {
  for (const lane of LANES) dropLane(lane);
};

// The one hard-reset path: /lsp-restart and the tool's restart action. Kills
// the daemons for everyone (that is what "restart" has to mean when the editor
// is shared) via qall! so language servers get a real shutdown.
const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T | null> => {
  let timer: NodeJS.Timeout;
  const guard = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p.catch(() => null), guard]);
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
    // A lane this process never touched may still have a daemon running.
    const adhoc = client ? null : await connect(lane);
    if (adhoc) client = attach({ reader: adhoc, writer: adhoc });
    if (!client) continue;
    killed = true;
    const pid = (await withTimeout(
      client.lua("return vim.uv.os_getpid()", []),
      1_000,
    )) as number | null;
    // qall! kills the channel mid-request, so the reply never arrives:
    // bounded wait, long enough for the write to land before we close our end.
    await withTimeout(client.command("qall!"), 500);
    dropLane(lane);
    adhoc?.end();
    // A wedged daemon can't process qall!, and "restart" has to mean restart.
    if (pid) {
      for (let i = 0; i < 20 && alive(pid); i++)
        await new Promise((r) => setTimeout(r, 100));
      if (alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
  return killed;
};

// In-process serialization. The daemon guards against cross-process
// interleaving (PiDaemon.guard); this keeps our own calls from piling into
// that guard's cooperative wait.
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

// Falls back to a direct call so a daemon predating the guard (or a plain nvim
// someone pointed the socket at) still answers instead of erroring.
const guarded = (code: string) => `
local f = function(...)
${code}
end
if _G.PiDaemon then return PiDaemon.guard(f, ...) end
return f(...)`;

const isBusy = (res: unknown): boolean =>
  typeof res === "object" && res !== null && "__pi_busy" in res;

// One logical call: retry for as long as a peer process holds the daemon
// guard. Every path into the daemon goes through here, including module loads
// — an unguarded load would redefine _G.PiLsp inside another client's vim.wait.
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
    await new Promise((r) => setTimeout(r, BUSY_RETRY_MS));
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
  // Checked when the queued task starts; returning false skips the lua call
  // (used by the feedback pipeline so a stale run can't reach nvim's
  // file-writing stages after a new turn began).
  preflight?: () => boolean,
): Promise<T> => {
  const { client } = await getSession(lane, cwd, onProgress);
  const combined = signal
    ? AbortSignal.any([signal, laneAborts[lane].signal])
    : laneAborts[lane].signal;
  if (combined.aborted) throw new Error("aborted");
  const exec = enqueue(lane, () => {
    // Re-check when the queued task actually starts — it may have waited
    // behind a long run, during which the caller aborted, the lane dropped,
    // or the work went stale.
    if (combined.aborted) throw new Error("aborted");
    if (preflight && !preflight()) throw new Error("stale");
    return callGuarded<T>(client, code, args, () => combined.aborted);
  });
  // Abort just stops awaiting: lua already running can't be cancelled and
  // runs to completion in nvim (bounded by lua-side budgets).
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      combined.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    combined.addEventListener("abort", onAbort, { once: true });
    exec.then(
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

// Hard cap on a single nav/diagnostics driver call. Lua-side budgets bound
// each op (attach 2.5s + progress 8s + per-file pulls), but a wedged nvim or
// a server that never returns would otherwise hang the tool forever, since
// callLua's abort only stops awaiting. Scale by file count so a cold
// multi-file diagnostics pass isn't cut short; the signal fires only on a
// real wedge.
const DRIVER_CAP_BASE_MS = 15_000;
const DRIVER_CAP_PER_FILE_MS = 8_000;

// Sugar: call _G.PiLsp.<fn>(args...) for navigation tools.
export const callDriver = async <T = unknown>(
  cwd: string,
  fn: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onProgress?: ProgressFn,
): Promise<T> => {
  await ensureDriverLoaded(cwd, onProgress);
  const fileCount = Array.isArray(args[0]) ? Math.max(1, args[0].length) : 1;
  const timeoutSignal = AbortSignal.timeout(
    DRIVER_CAP_BASE_MS + fileCount * DRIVER_CAP_PER_FILE_MS,
  );
  const combined = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return callLua<T>(cwd, `return PiLsp.${fn}(...)`, args, combined, onProgress);
};

// Which lua modules a daemon already carries, keyed by its epoch: a peer
// process may have loaded them before us, and the answer stops being true the
// moment the daemon restarts.
const loadedHere = new Set<string>();
const digest = (src: string) =>
  crypto.createHash("sha1").update(src).digest("hex").slice(0, 16);

// Load a lua module into the shared nvim at most once per daemon. The hash
// doubles as edit detection: changing driver.lua or feedback.lua reloads it
// into the running daemon on the next call instead of needing a restart.
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
  const current = await client.lua(`return vim.g[...]`, [flag] as never);
  if (current !== hash) {
    const deadline = AbortSignal.timeout(LOAD_TIMEOUT_MS);
    // Chunk-level locals become locals of the wrapper function — same closure
    // semantics for the module's own functions, no top-level `...` in either
    // driver.lua or feedback.lua to shadow.
    await callGuarded(client, src, [], () => deadline.aborted);
    await client.lua(`local k, v = ...; vim.g[k] = v`, [flag, hash] as never);
  }
  loadedHere.add(cacheKey);
};

// Re-read only when driver.lua actually changed on disk: this sits in front of
// every navigation call.
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

// Daemon-side vitals for /lsp-status.
export interface DaemonInfo {
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
