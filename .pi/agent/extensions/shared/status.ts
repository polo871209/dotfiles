// Agent-status vocabulary shared between notifier.ts (writer: encodes pi
// lifecycle into a tmux window/pane title) and subagent.ts (reader: polls a
// subagent pane's title to detect completion). Single source of truth so a
// rename can't silently break the reader.

export type AgentStatus = "busy" | "blocked" | "idle" | "done";

export const APP_TITLE = "\u03c0";

export const statusTitle = (status: AgentStatus): string =>
  `${APP_TITLE}-${status}`;

const STATUSES = new Set<string>(["busy", "blocked", "idle", "done"]);

// Parse a "<title>-<status>" pane/window title; undefined if no valid suffix.
export const parseStatusTitle = (title: string): AgentStatus | undefined => {
  const idx = title.lastIndexOf("-");
  if (idx === -1) return undefined;
  const s = title.slice(idx + 1);
  return STATUSES.has(s) ? (s as AgentStatus) : undefined;
};
