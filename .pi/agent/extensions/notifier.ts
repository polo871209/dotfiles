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

// Focus detection. Ported from opencode/plugins/notifier.ts.

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

// PIDs of every tmux client attached to *our* session. The same session can be
// attached from multiple ghostty windows; any of them being frontmost counts as
// focus, so we must check them all (picking a single client_pid misfires).
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

// false = no ghostty target, caller should use osascript.
//
// ghostty renders the window title as the notification subtitle, so on our own
// (visible) pane we briefly set it to the project name, fire the notification,
// then restore pi's title — otherwise the project name stays stuck in the
// titlebar (pi only re-asserts its title on session changes, not per turn).
//
// When pi's pane is hidden we route through a visible pane's tty (tmux drops
// passthrough from hidden panes) and skip the title dance entirely: changing a
// different window's title would just pollute it with no benefit, so that
// notification simply inherits whatever subtitle the carrier window already has.
const sendGhostty = async (
  project: string,
  body: string,
  restoreTitle: string,
): Promise<boolean> => {
  if (!isGhostty()) return false;

  try {
    if (process.env.TMUX_PANE && !(await isPaneVisible())) {
      const carrierTty = await getVisiblePaneTty();
      if (!carrierTty) return false;
      writeFileSync(carrierTty, notifySeq("pi", body));
      return true;
    }

    // Own pane, visible. stdout works under pi's takeOverStdout (reroutes to
    // fd2, same pty tmux reads, same as OSC 52).
    process.stdout.write(titleSeq(project));
    await delay(GHOSTTY_TITLE_SETTLE_MS);
    process.stdout.write(notifySeq("pi", body));
    // Wait before restoring so ghostty captures the project title for the
    // banner before the title reverts (title application is async/debounced).
    await delay(GHOSTTY_TITLE_SETTLE_MS);
    process.stdout.write(titleSeq(restoreTitle));
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

// Reflect the agent's status in this pane's tmux window name so the tab makes
// it obvious at a glance which agent is busy / waiting / done. Renaming pins
// the name (disables tmux automatic-rename), which is what we want per window.
const setWindowStatus = (status: "busy" | "ask" | "idle" | "done"): void => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  execFile(
    "tmux",
    ["rename-window", "-t", pane, `${APP_TITLE}-${status}`],
    { timeout: 2000 },
    () => {},
  );
};

// "done" means the turn finished while you weren't looking. Poll for focus
// returning to this pane and flip done -> idle so the tab distinguishes "just
// finished" from "you've already seen it". Any new activity cancels the poll.
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

// Reconstruct the title pi assigns (interactive-mode.updateTerminalTitle) so we
// can restore it after temporarily setting the project name for the banner.
const APP_TITLE = "\u03c0";
const piTitle = (projectName: string, sessionName?: string): string =>
  sessionName
    ? `${APP_TITLE} - ${sessionName} - ${projectName}`
    : `${APP_TITLE} - ${projectName}`;

const notify = async (
  projectName: string,
  message: string,
  sessionName: string | undefined,
): Promise<void> => {
  if (await isTerminalFocused()) return;
  if (shouldThrottle(`${projectName}\x00${message}`)) return;
  // When ghostty is the focused app (e.g. another tmux window) it suppresses
  // its own OSC banner — sound only. That's ghostty's design, not overridable.
  if (
    !(await sendGhostty(
      projectName,
      message,
      piTitle(projectName, sessionName),
    ))
  ) {
    await sendOsascript(`pi - ${projectName}`, message);
  }
  playSound();
};

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;
  let projectName = path.basename(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    projectName = path.basename(ctx.cwd ?? process.cwd());
    stopDonePoll();
    setWindowStatus("idle");
  });

  pi.on("agent_start", async () => {
    stopDonePoll();
    setWindowStatus("busy");
  });

  pi.on("tool_execution_start", async (event) => {
    if (event.toolName === "ask_user_question") setWindowStatus("ask");
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "ask_user_question") setWindowStatus("busy");
  });

  pi.on("agent_end", async () => {
    if (await isTerminalFocused()) {
      setWindowStatus("idle");
    } else {
      setWindowStatus("done");
      startDonePoll();
    }
    await notify(projectName, "Turn complete", pi.getSessionName());
  });

  pi.on("session_shutdown", async () => {
    stopDonePoll();
  });
}
