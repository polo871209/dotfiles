// Builds the above-editor widget lines summarizing a feedback run.
import { displayPath, formatDiagLine, sortDiagnostics } from "../utils";
import type { DriverResult } from "./types";

const MAX_LINES_OUT = 50;

export const buildWidgetLines = (
  r: DriverResult,
  cwd: string,
  fixedFiles: string[] = [],
  fixSkipped = false,
): string[] | null => {
  const diags = sortDiagnostics(r.diagnostics);
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
    for (const d of shown) lines.push(formatDiagLine(d, cwd));
    if (diags.length > shown.length) {
      lines.push(`  … (+${diags.length - shown.length} more)`);
    }
  } else if (fixed.length > 0) {
    lines.push("all diagnostics fixed ✓");
  }
  return lines;
};
