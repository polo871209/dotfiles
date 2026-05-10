// notifier — macOS desktop notifications when pi finishes a turn and the
// user is not currently looking at this tmux pane.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { exec, execFile } from "node:child_process";
import * as path from "node:path";

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

// --- Focus detection (ported from opencode/plugins/notifier.ts) -----------

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

const getAncestorPids = async (startPid: number): Promise<Set<number>> => {
  const ancestors = new Set<number>();
  try {
    const out = await execP("ps -eo pid=,ppid=", 1500);
    const parents = new Map<number, number>();
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) {
        parents.set(parseInt(parts[0], 10), parseInt(parts[1], 10));
      }
    }
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
    const target = process.env.TMUX_PANE ? `-t ${process.env.TMUX_PANE} ` : "";
    const out = await execP(`tmux display-message ${target}-p '#{client_pid}'`);
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
    const out = await execP(
      `tmux display-message -t ${pane} -p '#{session_attached} #{window_active} #{pane_active}'`,
    );
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

// --- Notification delivery -------------------------------------------------

const debounce = new Map<string, number>();

const escapeAS = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const sendNotification = async (
  title: string,
  message: string,
): Promise<void> => {
  const key = `${title}\x00${message}`;
  const now = Date.now();
  if ((debounce.get(key) ?? 0) > now - 1000) return;
  debounce.set(key, now);

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
  execFile(
    "afplay",
    ["/System/Library/Sounds/Blow.aiff"],
    { timeout: 5000 },
    () => {},
  );
};

const notify = async (projectName: string, message: string): Promise<void> => {
  if (await isTerminalFocused()) return;
  await sendNotification(`pi - ${projectName}`, message);
  playSound();
};

// --- Extension entry -------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let projectName = path.basename(process.cwd());

  pi.on("session_start", async (_event, ctx) => {
    projectName = path.basename(ctx.cwd ?? process.cwd());
  });

  pi.on("agent_end", async () => {
    await notify(projectName, "Turn complete");
  });
}
