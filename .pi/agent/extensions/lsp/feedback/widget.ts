// Builds the above-editor widget lines summarizing a feedback run.
import { displayPath } from "../utils";
import type { DriverResult, Severity } from "./types";

const MAX_LINES_OUT = 50;

const sevTag: Record<Severity, string> = {
  error: "error",
  warn: "warn ",
  info: "info ",
  hint: "hint ",
};

const sevRank: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
  hint: 3,
};

export const buildWidgetLines = (
  r: DriverResult,
  cwd: string,
  fixedFiles: string[] = [],
  fixSkipped = false,
): string[] | null => {
  const diags = [...r.diagnostics].sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    const f = a.file.localeCompare(b.file);
    if (f !== 0) return f;
    return a.line - b.line;
  });
  const formatted = r.formatted.map((f) => displayPath(f, cwd));
  const fixed = fixedFiles.map((f) => displayPath(f, cwd));

  // Suppress notice when nothing actionable happened (pure format-only run).
  if (diags.length === 0 && fixed.length === 0) return null;

  const lines: string[] = ["lsp-feedback"];
  if (fixed.length > 0) lines.push(`llm-fixed: ${fixed.join(", ")}`);
  if (formatted.length > 0) lines.push(`formatted: ${formatted.join(", ")}`);
  if (fixSkipped)
    lines.push(
      "fixable issues found; auto-fix is off (`/lsp-fix on` to enable)",
    );
  if (diags.length > 0) {
    if (formatted.length > 0 || fixed.length > 0 || fixSkipped) lines.push("");
    lines.push(`${diags.length} diagnostic(s):`);
    const shown = diags.slice(0, MAX_LINES_OUT);
    for (const d of shown) {
      const loc = displayPath(d.file, cwd);
      const src = d.source
        ? `${d.source}${d.code ? `(${d.code})` : ""}`
        : (d.code ?? "");
      lines.push(
        `  ${loc}:${d.line}:${d.col}  ${sevTag[d.severity]}  ${src ? `${src}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`,
      );
    }
    if (diags.length > shown.length) {
      lines.push(`  … (+${diags.length - shown.length} more)`);
    }
  } else if (fixed.length > 0) {
    lines.push("all diagnostics fixed ✓");
  }
  return lines;
};
