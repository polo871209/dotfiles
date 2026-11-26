export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

export const preview = (text: string, limit = 60): string => {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);

  const compact = (line ?? "(empty)").replace(/\s+/g, " ");

  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
};
