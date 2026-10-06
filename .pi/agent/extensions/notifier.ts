import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec, execFile, execFileSync } from "node:child_process";
import { APP_TITLE, statusTitle, type AgentStatus } from "./shared/status";
import { writeFileSync } from "node:fs";
import * as path from "node:path";

const IS_SUBAGENT = process.env.PI_IS_SUBAGENT === "1";
const SOUND_PATH = "/System/Library/Sounds/Glass.aiff";
const ESC = "\x1b";
const BEL = "\x07";

const isGhostty = (): boolean =>
  process.env.TERM_PROGRAM === "ghostty" ||
  !!process.env.GHOSTTY_RESOURCES_DIR ||
  !!process.env.GHOSTTY_BIN_DIR;

const execP = (cmd: string, timeoutMs = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? "").trim());
    });
  });

const execFileP = (
  file: string,
  args: string[],
  timeoutMs = 2000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? "").trim());
    });
  });

const getFrontmostPid = async (): Promise<number | null> => {
  try {
    const out = await execFileP(
      "osascript",
      [
        "-e",
        'tell application "System Events" to get unix id of first application process whose frontmost is true',
      ],
      2500,
    );
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
};

let psCache: { at: number; parents: Map<number, number> } | null = null;
const PS_TTL_MS = 2000;

const getParentMap = async (): Promise<Map<number, number>> => {
  const now = Date.now();
  if (psCache && now - psCache.at < PS_TTL_MS) return psCache.parents;
  const parents = new Map<number, number>();
  try {
    const out = await execP("ps -eo pid=,ppid=", 1500);
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        parents.set(parseInt(parts[0], 10), parseInt(parts[1], 10));
      }
    }
  } catch {}
  psCache = { at: now, parents };
  return parents;
};

const getAncestorPids = async (startPid: number): Promise<Set<number>> => {
  const ancestors = new Set<number>();
  try {
    const parents = await getParentMap();
    let pid = startPid;
    while (pid > 1) {
      ancestors.add(pid);
      const ppid = parents.get(pid);
      if (ppid === undefined || ppid === pid) break;
      pid = ppid;
    }
  } catch {}
  return ancestors;
};

const getOurSessionClientPids = async (): Promise<number[]> => {
  try {
    const pane = process.env.TMUX_PANE;
    const sessArgs = pane
      ? ["display-message", "-t", pane, "-p", "#{session_name}"]
      : ["display-message", "-p", "#{session_name}"];
    const ourSession = await execFileP("tmux", sessArgs);
    const out = await execFileP("tmux", [
      "list-clients",
      "-F",
      "#{client_pid} #{client_session}",
    ]);
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const idx = line.indexOf(" ");
      if (idx < 0) continue;
      const pid = parseInt(line.slice(0, idx), 10);
      const sess = line.slice(idx + 1).trim();
      if (Number.isFinite(pid) && sess === ourSession) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
};

const isTmuxPaneActive = async (): Promise<boolean> => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return true;
  try {
    const out = await execFileP("tmux", [
      "display-message",
      "-t",
      pane,
      "-p",
      "#{session_attached} #{window_active} #{pane_active}",
    ]);
    const [attached, win, p] = out.split(" ");
    return attached === "1" && win === "1" && p === "1";
  } catch {
    return true;
  }
};

const isTerminalFocused = async (): Promise<boolean> => {
  try {
    const front = await getFrontmostPid();
    if (front === null) return false;
    const clientPids = await getOurSessionClientPids();
    if (clientPids.length === 0) return false;
    let frontIsOurClient = false;
    for (const pid of clientPids) {
      const ancestors = await getAncestorPids(pid);
      if (ancestors.has(front)) {
        frontIsOurClient = true;
        break;
      }
    }
    if (!frontIsOurClient) return false;
    return isTmuxPaneActive();
  } catch {
    return false;
  }
};

const debounce = new Map<string, number>();

const shouldThrottle = (key: string): boolean => {
  const now = Date.now();
  if ((debounce.get(key) ?? 0) > now - 1000) return true;
  debounce.set(key, now);
  if (debounce.size > 32) {
    for (const [k, t] of debounce) {
      if (now - t > 5000) debounce.delete(k);
    }
  }
  return false;
};

const escapeAS = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");

// OSC 777 fields are ';'-separated; control chars / ';' would corrupt the
// sequence, so neutralise them.
const sanitizeOsc = (s: string): string =>
  s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/;/g, ":");

// Inside tmux an OSC must be wrapped in a DCS passthrough or tmux swallows it
// (needs `set -g allow-passthrough on`). Every inner ESC byte is doubled.
const wrapPassthrough = (raw: string): string =>
  process.env.TMUX_PANE
    ? `${ESC}Ptmux;${raw.replace(/\x1b/g, ESC + ESC)}${ESC}\\`
    : raw;

const notifySeq = (title: string, body: string): string =>
  wrapPassthrough(
    `${ESC}]777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}${BEL}`,
  );
const titleSeq = (title: string): string =>
  wrapPassthrough(`${ESC}]0;${sanitizeOsc(title)}${BEL}`);

const GHOSTTY_TITLE_SETTLE_MS = 300;
let lastGhosttyTitle: string | null = null;
const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// tmux only forwards passthrough from visible panes (pane_active irrelevant).
const isPaneVisible = async (): Promise<boolean> => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return true;
  try {
    const out = await execFileP("tmux", [
      "display-message",
      "-t",
      pane,
      "-p",
      "#{session_attached} #{window_active}",
    ]);
    const [attached, win] = out.split(" ");
    return attached === "1" && win === "1";
  } catch {
    return false;
  }
};

const getVisiblePaneTty = async (): Promise<string | null> => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  try {
    const out = await execFileP("tmux", [
      "list-panes",
      "-s",
      "-t",
      pane,
      "-F",
      "#{pane_tty} #{session_attached} #{window_active} #{pane_active}",
    ]);
    for (const line of out.split("\n")) {
      const [tty, attached, win, paneActive] = line.trim().split(" ");
      if (attached === "1" && win === "1" && paneActive === "1" && tty) {
        return tty;
      }
    }
  } catch {}
  return null;
};

const trySendGhostty = async (
  project: string,
  body: string,
): Promise<boolean> => {
  if (!isGhostty()) return false;

  try {
    const send = async (write: (seq: string) => void): Promise<void> => {
      if (lastGhosttyTitle !== project) {
        write(titleSeq(project));
        lastGhosttyTitle = project;
        await delay(GHOSTTY_TITLE_SETTLE_MS);
      }
      write(notifySeq(APP_TITLE, body));
    };

    if (process.env.TMUX_PANE && !(await isPaneVisible())) {
      const carrierTty = await getVisiblePaneTty();
      if (!carrierTty) return false;
      await send((seq) => writeFileSync(carrierTty, seq));
      return true;
    }

    // Own pane, visible. In interactive mode stdout is the pty tmux reads. Print
    // and RPC modes reroute stdout to fd 2 (takeOverStdout), the same pty.
    await send((seq) => process.stdout.write(seq));
    return true;
  } catch {
    return false;
  }
};

const sendOsascript = async (title: string, message: string): Promise<void> => {
  try {
    await execFileP(
      "osascript",
      [
        "-e",
        `display notification "${escapeAS(message)}" with title "${escapeAS(title)}"`,
      ],
      3000,
    );
  } catch {}
};

const playSound = (): void => {
  execFile("afplay", [SOUND_PATH], { timeout: 5000 }, () => {});
};

let windowStatusChain: Promise<void> = Promise.resolve();
const setWindowStatus = (status: AgentStatus): void => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  const title = statusTitle(status);
  windowStatusChain = windowStatusChain.then(
    () =>
      new Promise((resolve) => {
        execFile(
          "tmux",
          IS_SUBAGENT
            ? ["select-pane", "-t", pane, "-T", title]
            : ["rename-window", "-t", pane, title],
          { timeout: 2000 },
          () => resolve(),
        );
      }),
  );
};

let donePoll: ReturnType<typeof setInterval> | null = null;
const stopDonePoll = (): void => {
  if (donePoll) {
    clearInterval(donePoll);
    donePoll = null;
  }
};
const startDonePoll = (): void => {
  if (!process.env.TMUX_PANE || donePoll) return;
  donePoll = setInterval(async () => {
    if (await isTerminalFocused()) {
      setWindowStatus("idle");
      stopDonePoll();
    }
  }, 2000);
  donePoll.unref?.();
};

const notify = async (projectName: string, message: string): Promise<void> => {
  if (await isTerminalFocused()) return;
  if (shouldThrottle(`${projectName}\x00${message}`)) return;
  if (!(await trySendGhostty(projectName, message))) {
    await sendOsascript(`${APP_TITLE}-${projectName}`, message);
  }
  playSound();
};

export default function (pi: ExtensionAPI) {
  let projectName = path.basename(process.cwd());
  let turnGeneration = 0;
  let blockedOnPrompt = false;

  pi.on("session_start", async (_event, ctx) => {
    projectName = path.basename(ctx.cwd ?? process.cwd());
    stopDonePoll();
    setWindowStatus("idle");
  });

  pi.on("agent_start", async () => {
    turnGeneration++;
    blockedOnPrompt = false;
    stopDonePoll();
    setWindowStatus("busy");
  });

  pi.on("ui_prompt_start", async (_event, ctx) => {
    if (ctx.isIdle()) return;
    blockedOnPrompt = true;
    setWindowStatus("blocked");
    if (!IS_SUBAGENT) {
      await notify(projectName, "waiting");
    }
  });

  pi.on("ui_prompt_end", async () => {
    if (!blockedOnPrompt) return;
    blockedOnPrompt = false;
    setWindowStatus("busy");
  });

  pi.on("agent_settled", async () => {
    const gen = turnGeneration;
    // Detached because pi waits for this handler and the focus check spawns
    // osascript.
    void (async () => {
      if (IS_SUBAGENT) {
        setWindowStatus("done");
        return;
      }
      const focused = await isTerminalFocused();
      if (gen !== turnGeneration) return;
      if (focused) {
        setWindowStatus("idle");
      } else {
        setWindowStatus("done");
        startDonePoll();
      }
      await notify(projectName, "done");
    })();
  });

  // On quit, hand the window name back to tmux: rename-window turned off
  // automatic-rename, so the tab would keep "π-<status>" after pi exits.
  // Sync, because the process exits right after this handler.
  pi.on("session_shutdown", async (event) => {
    stopDonePoll();
    const pane = process.env.TMUX_PANE;
    if (event.reason !== "quit" || !pane || IS_SUBAGENT) return;
    try {
      execFileSync(
        "tmux",
        ["set-window-option", "-t", pane, "automatic-rename", "on"],
        { timeout: 2000 },
      );
    } catch {}
  });
}
