// notifier — desktop notification when pi finishes a turn and this tmux pane
// isn't focused. ghostty OSC 777 (via tmux passthrough) where possible, else
// osascript. ghostty forces subtitle = window title, so we set it to the
// project name -> "pi" / "<project>" / "<message>".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec, execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";

const DISABLED = process.env.PI_IS_SUBAGENT === "1";
const SOUND_PATH = "/System/Library/Sounds/Blow.aiff";
const ESC = "\x1b";
const BEL = "\x07";

const isGhostty = (): boolean =>
  process.env.TERM_PROGRAM === "ghostty" ||
  !!process.env.GHOSTTY_RESOURCES_DIR ||
  !!process.env.GHOSTTY_BIN_DIR;

const execP = (cmd: string, timeoutMs = 1000): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? "").trim());
    });
  });

const execFileP = (
  file: string,
  args: string[],
  timeoutMs = 1000,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? "").trim());
    });
  });

// Focus detection. Ported from opencode/plugins/notifier.ts.

const getFrontmostPid = async (): Promise<number | null> => {
  try {
    const out = await execFileP("osascript", [
      "-e",
      'tell application "System Events" to get unix id of first application process whose frontmost is true',
    ]);
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
};

// Cache ps output briefly so repeated focus checks don't re-scan the process
// table every notification.
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
  } catch {
    /* ignore */
  }
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
  } catch {
    /* ignore */
  }
  return ancestors;
};

const getTmuxClientPid = async (): Promise<number | null> => {
  try {
    const args = process.env.TMUX_PANE
      ? ["display-message", "-t", process.env.TMUX_PANE, "-p", "#{client_pid}"]
      : ["display-message", "-p", "#{client_pid}"];
    const out = await execFileP("tmux", args);
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
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
    const clientPid = await getTmuxClientPid();
    if (clientPid === null) return false;
    const ancestors = await getAncestorPids(clientPid);
    if (!ancestors.has(front)) return false;
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
  // Prune entries older than 5s to keep the map bounded.
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

const titleSeq = (title: string): string =>
  wrapPassthrough(`${ESC}]0;${sanitizeOsc(title)}${BEL}`);
const notifySeq = (title: string, body: string): string =>
  wrapPassthrough(
    `${ESC}]777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}${BEL}`,
  );

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ghostty applies title changes async; wait so the notification subtitle isn't
// stale.
const GHOSTTY_TITLE_SETTLE_MS = 300;

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

// When pi's pane is hidden, find a visible pane to carry the passthrough (same
// ghostty surface). null = nothing visible (fully detached).
const getVisiblePaneTty = async (): Promise<string | null> => {
  try {
    const out = await execFileP("tmux", [
      "list-panes",
      "-a",
      "-F",
      "#{pane_tty} #{session_attached} #{window_active} #{pane_active}",
    ]);
    for (const line of out.split("\n")) {
      const [tty, attached, win, paneActive] = line.trim().split(" ");
      if (attached === "1" && win === "1" && paneActive === "1" && tty) {
        return tty;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
};

// false = no ghostty target, caller should use osascript. Sets the window
// title first because ghostty renders it as the notification subtitle.
const sendGhostty = async (project: string, body: string): Promise<boolean> => {
  if (!isGhostty()) return false;

  // pi's pane hidden -> route through a visible pane's tty (tmux drops
  // passthrough from hidden panes). stdout otherwise — works under pi's
  // takeOverStdout (reroutes to fd2, same pty tmux reads, same as OSC 52).
  let carrierTty: string | null = null;
  if (process.env.TMUX_PANE && !(await isPaneVisible())) {
    carrierTty = await getVisiblePaneTty();
    if (!carrierTty) return false;
  }
  const emit = (seq: string): void => {
    if (carrierTty) writeFileSync(carrierTty, seq);
    else process.stdout.write(seq);
  };

  try {
    emit(titleSeq(project));
    await delay(GHOSTTY_TITLE_SETTLE_MS);
    emit(notifySeq("pi", body));
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
  } catch {
    /* ignore */
  }
};

const playSound = (): void => {
  execFile("afplay", [SOUND_PATH], { timeout: 5000 }, () => {});
};

const notify = async (projectName: string, message: string): Promise<void> => {
  if (await isTerminalFocused()) return;
  if (shouldThrottle(`${projectName}\x00${message}`)) return;
  // When ghostty is the focused app (e.g. another tmux window) it suppresses
  // its own OSC banner — sound only. That's ghostty's design, not overridable.
  if (!(await sendGhostty(projectName, message))) {
    await sendOsascript(`pi - ${projectName}`, message);
  }
  playSound();
};

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;
  let projectName = path.basename(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    projectName = path.basename(ctx.cwd ?? process.cwd());
  });

  pi.on("agent_end", async () => {
    await notify(projectName, "Turn complete");
  });
}
