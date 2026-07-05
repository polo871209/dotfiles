import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  formatDiagLine,
  normalizeAtPath,
  sortDiagnostics,
  toAbs,
  withDriver,
  type Diag,
  type DriverErr,
} from "../utils";

interface DiagResult extends DriverErr {
  diagnostics?: Diag[];
}

export const diagnosticsTool = defineTool({
  name: "lsp_diagnostics",
  label: "LSP Diagnostics",
  description:
    "LSP + linter diagnostics for one or more files — type errors, lint warnings, etc., scoped to the files you pass. Read-only: never formats, fixes, or writes. Do NOT call this to verify or check files you just edited — post-edit checks are handled for you, so editing is never a trigger. Use ONLY when the user explicitly asks for diagnostics, or to inspect a reported error you have not yet seen.",
  promptSnippet: "Check a file's errors/warnings on demand (not after edits)",
  promptGuidelines: [
    "Editing a file is NOT a reason to call lsp_diagnostics — post-edit checks happen automatically.",
    "Call only when the user explicitly asks for diagnostics, or when debugging an error you have not yet observed.",
    "Prefer lsp_diagnostics over shelling out to `tsc`/`eslint` for those on-demand per-file checks.",
  ],
  parameters: Type.Object({
    files: Type.Array(Type.String(), {
      minItems: 1,
      description: "Absolute or cwd-relative file paths to diagnose.",
    }),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const p = params as { files: string[] };
    const files = p.files.map((f) => toAbs(normalizeAtPath(f), ctx.cwd));

    return withDriver<DiagResult>(
      ctx,
      "diagnostics",
      [files],
      signal,
      onUpdate,
      (res, cwd) => {
        const diags = sortDiagnostics(res.diagnostics ?? []);
        const errors = diags.filter((d) => d.severity === "error").length;
        const warns = diags.filter((d) => d.severity === "warn").length;

        if (diags.length === 0) {
          return {
            text: "No diagnostics ✓",
            details: { count: 0, errors: 0, warns: 0 },
          };
        }

        const lines = [
          `${diags.length} diagnostic(s) (${errors} error, ${warns} warn):`,
        ];
        for (const d of diags) lines.push(formatDiagLine(d, cwd));
        const t = truncateHead(lines.join("\n"), {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        let text = t.content;
        if (t.truncated) {
          text += `\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`;
        }
        return { text, details: { count: diags.length, errors, warns } };
      },
    );
  },
});
