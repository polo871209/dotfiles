export type AgentStatus = "busy" | "blocked" | "idle" | "done";

export const APP_TITLE = "\u03c0";

export const statusTitle = (status: AgentStatus): string =>
  `${APP_TITLE}-${status}`;

const STATUSES = new Set<string>(["busy", "blocked", "idle", "done"]);

export const parseStatusTitle = (title: string): AgentStatus | undefined => {
  const idx = title.lastIndexOf("-");
  if (idx === -1) return undefined;
  const s = title.slice(idx + 1);
  return STATUSES.has(s) ? (s as AgentStatus) : undefined;
};
