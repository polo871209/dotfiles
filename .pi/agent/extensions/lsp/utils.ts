// Shared formatting + path helpers for navigation tools.

import * as path from "node:path";
import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { callDriver } from "./nvim";

export interface LspLocation {
  file: string;
  line: number;
  col: number;
  context: string;
}

export interface DriverErr {
  ok: boolean;
  error?: string;
}

export interface NavParams {
  file: string;
  line: number;
  symbol?: string;
}

// Wraps the file → abs → callDriver → ok/err pattern shared by
// hover/definition/references.
export async function runNavTool<R extends DriverErr>(
  driverFn: string,
  params: NavParams,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onUpdate: ((r: AgentToolResult<unknown>) => void) | undefined,
  render: (
    res: R,
    cwd: string,
  ) => { text: string; details?: Record<string, unknown> },
): Promise<AgentToolResult<unknown>> {
  const file = toAbs(normalizeAtPath(params.file), ctx.cwd);
  const progress = (text: string) =>
    onUpdate?.({ content: [{ type: "text", text }], details: {} });
  const res = await callDriver<R>(
    ctx.cwd,
    driverFn,
    [file, params.line, params.symbol ?? ""],
    signal,
    progress,
  );
  if (!res.ok) {
    return {
      content: [{ type: "text", text: `LSP error: ${res.error ?? "unknown"}` }],
      details: { success: false },
    };
  }
  const out = render(res, ctx.cwd);
  return {
    content: [{ type: "text", text: out.text }],
    details: { success: true, ...(out.details ?? {}) },
  };
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
