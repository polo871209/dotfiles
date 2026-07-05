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

// Wraps the toAbs → progress → callDriver → ok/err pattern shared by every
// LSP tool. Takes the raw driver args directly so callers with different
// shapes (rename's extra new_name, document_symbols' file-only, diagnostics'
// files array) don't have to re-roll this themselves.
export async function withDriver<R extends DriverErr>(
  ctx: ExtensionContext,
  driverFn: string,
  args: unknown[],
  signal: AbortSignal | undefined,
  onUpdate: ((r: AgentToolResult<unknown>) => void) | undefined,
  render: (
    res: R,
    cwd: string,
  ) => { text: string; details?: Record<string, unknown> },
  errorPrefix = "LSP error",
): Promise<AgentToolResult<unknown>> {
  const progress = (text: string) =>
    onUpdate?.({ content: [{ type: "text", text }], details: {} });
  const res = await callDriver<R>(ctx.cwd, driverFn, args, signal, progress);
  if (!res.ok) {
    return {
      content: [
        { type: "text", text: `${errorPrefix}: ${res.error ?? "unknown"}` },
      ],
      details: { success: false },
    };
  }
  const out = render(res, ctx.cwd);
  return {
    content: [{ type: "text", text: out.text }],
    details: { success: true, ...(out.details ?? {}) },
  };
}

// Anchor-shaped (file, line, symbol) tools — hover/definition/references/
// implementation/type_definition.
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
  return withDriver<R>(
    ctx,
    driverFn,
    [file, params.line, params.symbol ?? ""],
    signal,
    onUpdate,
    render,
  );
}

// Shared promptGuidelines for the anchor-based nav tools: a one-line purpose
// plus the anchor-freshness reminder. Keeps the nav tools consistent.
export const anchorGuidelines = (purpose: string): string[] => [
  purpose,
  "Anchor at a current file:line — stale line numbers cause misses.",
];

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

export type Severity = "error" | "warn" | "info" | "hint";

export interface Diag {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  source?: string;
  code?: string;
  message: string;
}

const SEV_TAG: Record<Severity, string> = {
  error: "error",
  warn: "warn ",
  info: "info ",
  hint: "hint ",
};

const SEV_RANK: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
  hint: 3,
};

// Shared by lsp_diagnostics and the post-edit feedback widget so severity
// ordering and line formatting stay identical between the two.
export const sortDiagnostics = <D extends Diag>(diags: D[]): D[] =>
  [...diags].sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    const f = a.file.localeCompare(b.file);
    if (f !== 0) return f;
    return a.line - b.line;
  });

export const formatDiagLine = (d: Diag, cwd: string): string => {
  const loc = displayPath(d.file, cwd);
  const src = d.source
    ? `${d.source}${d.code ? `(${d.code})` : ""}`
    : (d.code ?? "");
  return `  ${loc}:${d.line}:${d.col}  ${SEV_TAG[d.severity]}  ${src ? `${src}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`;
};

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
