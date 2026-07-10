// notifier — desktop notification when pi finishes a turn, or blocks on
// ask_user_question, and this tmux pane isn't focused. ghostty OSC 777 (via
// tmux passthrough) where possible, else osascript. ghostty forces subtitle =
// window title, so we set it to the project name -> "pi" / "<project>" /
// "<message>".
//
// Also renames this pane's tmux window to reflect the agent's status (busy /
// ask / done / idle) so the tab makes it obvious at a glance, and subagent.ts
// polls that same window name to know when a subagent pane has finished.
// Subagent panes (PI_IS_SUBAGENT=1) still get the window rename — the parent
// needs it to poll completion — but skip the desktop notification/sound,
// which would otherwise fire once per subagent turn.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec, execFile } from "node:child_process";
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

const notifySeq = (title: string, body: string): string =>
  wrapPassthrough(
    `${ESC}]777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}${BEL}`,
  );
const titleSeq = (title: string): string =>
  wrapPassthrough(`${ESC}]0;${sanitizeOsc(title)}${BEL}`);

// ghostty applies title changes async; wait so the banner subtitle isn't
// stale. Only needed when the title actually changes.
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
// ghostty forces the window title in as the banner's subtitle line — not
// removable (empty title falls back to pwd, space renders a blank line).
// Nothing else manages the OS window title under tmux (set-titles off), so
// whatever stale bytes last landed there would show as the subtitle — set it
// to the project first, no restore needed. When pi's pane is hidden we route
// through a visible pane's tty (tmux drops passthrough from hidden panes).
const sendGhostty = async (project: string, body: string): Promise<boolean> => {
  if (!isGhostty()) return false;

  try {
    // Banner layout: line 1 = notify title (app), line 2 = window title
    // (project), line 3 = body.
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

    // Own pane, visible. stdout works under pi's takeOverStdout (reroutes to
    // fd2, same pty tmux reads, same as OSC 52).
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
//
// A subagent pane shares its window with the parent pi session (subagent.ts
// splits a pane instead of opening a new window), so renaming the window
// would fight over one name with two writers. Subagent panes set their own
// pane title instead (per-pane, `select-pane -T`) — invisible to the user,
// but subagent.ts polls it to know when that pane's turn finished.
const setWindowStatus = (status: AgentStatus): void => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return;
  const title = statusTitle(status);
  execFile(
    "tmux",
    IS_SUBAGENT
      ? ["select-pane", "-t", pane, "-T", title]
      : ["rename-window", "-t", pane, title],
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

const notify = async (projectName: string, message: string): Promise<void> => {
  if (await isTerminalFocused()) return;
  if (shouldThrottle(`${projectName}\x00${message}`)) return;
  // When ghostty is the focused app (e.g. another tmux window) it suppresses
  // its own OSC banner — sound only. That's ghostty's design, not overridable.
  if (!(await sendGhostty(projectName, message))) {
    await sendOsascript(`${APP_TITLE}-${projectName}`, message);
  }
  playSound();
};

export default function (pi: ExtensionAPI) {
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
    if (event.toolName !== "ask_user_question") return;
    setWindowStatus("blocked");
    // A subagent blocked on a question needs the parent to notice via
    // subagent.ts's pane-title poll, not a desktop ping nobody but the
    // parent's own turn logic is meant to react to.
    if (!IS_SUBAGENT) {
      await notify(projectName, "waiting");
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "ask_user_question") setWindowStatus("busy");
  });

  // agent_settled, not agent_end: agent_end also fires mid auto-retry /
  // auto-compact / queued follow-ups, causing premature "done" + pings.
  pi.on("agent_settled", async () => {
    if (IS_SUBAGENT) {
      // subagent.ts polls this window name to know when the pane is done;
      // no notification/sound for a background turn nobody is watching.
      setWindowStatus("done");
      return;
    }
    if (await isTerminalFocused()) {
      setWindowStatus("idle");
    } else {
      setWindowStatus("done");
      startDonePoll();
    }
    await notify(projectName, "done");
  });

  pi.on("session_shutdown", async () => {
    stopDonePoll();
  });
}
