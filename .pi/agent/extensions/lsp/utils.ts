// Shared formatting + path helpers for navigation tools.

import * as path from "node:path";

export interface LspLocation {
  file: string;
  line: number;
  col: number;
  context: string;
}

export const displayPath = (abs: string, cwd: string): string => {
  if (!abs) return abs;
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
  return rel;
};

export const toAbs = (p: string, cwd: string): string =>
  path.isAbsolute(p) ? p : path.resolve(cwd, p);

// LLMs sometimes prefix paths with @. Strip it to match built-in tool behavior.
export const normalizeAtPath = (p: string): string =>
  p.startsWith("@") ? p.slice(1) : p;

export const formatLocations = (
  locations: LspLocation[],
  cwd: string,
  label: string,
): string => {
  if (locations.length === 0) return `No ${label} found`;
  const lines: string[] = [`Found ${locations.length} ${label}:`];
  for (const loc of locations) {
    const rel = displayPath(loc.file, cwd);
    lines.push(`  ${rel}:${loc.line}:${loc.col}  ${loc.context}`);
  }
  return lines.join("\n");
};
