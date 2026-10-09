export type AgentStatus = "busy" | "blocked" | "idle" | "done";

export const APP_TITLE = "\u03c0";

export const statusTitle = (status: AgentStatus): string =>
  `${APP_TITLE}-${status}`;

export const parseStatusTitle = (title: string): AgentStatus | undefined => {
  const idx = title.lastIndexOf("-");
  if (idx === -1) return undefined;
  const s = title.slice(idx + 1);
  return ["busy", "blocked", "idle", "done"].includes(s)
    ? (s as AgentStatus)
    : undefined;
};
