// Shared formatting + path helpers for navigation tools.

import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type AgentToolResult,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { callDriver } from "./nvim";

// Cap tool output at pi's default budgets so an unbounded LSP response
// (overload-heavy definitions, giant hover docs) can't flood agent context.
export const capText = (full: string): { text: string; truncated: boolean } => {
  const t = truncateHead(full, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = t.content;
  if (t.truncated) {
    text += `\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`;
  }
  return { text, truncated: t.truncated };
};

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

// Wraps the toAbs → progress → callDriver → ok/err pattern shared by every
// LSP tool. Takes the raw driver args directly so callers with different
// shapes (document_symbols' file-only, diagnostics'
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
  // callDriver enforces the hard timeout (wedged-nvim guard). Here we just
  // turn a thrown abort/timeout into a clean tool error instead of a crash.
  let res: R;
  try {
    res = await callDriver<R>(ctx.cwd, driverFn, args, signal, progress);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      content: [{ type: "text", text: `${errorPrefix}: ${reason}` }],
      details: { success: false },
    };
  }
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

// Shared by the lsp tool's diagnostics action and the post-edit feedback widget so severity
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
