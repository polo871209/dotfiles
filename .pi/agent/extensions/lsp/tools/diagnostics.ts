import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { callDriver } from "../nvim";
import { displayPath, normalizeAtPath, toAbs, type DriverErr } from "../utils";

type Severity = "error" | "warn" | "info" | "hint";
interface Diag {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  source?: string;
  code?: string;
  message: string;
}
interface DiagResult extends DriverErr {
  diagnostics?: Diag[];
}

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

export const diagnosticsTool = defineTool({
  name: "lsp_diagnostics",
  label: "LSP Diagnostics",
  description:
    "LSP + linter diagnostics for one or more files — type errors, lint warnings, etc. Faster than a project-wide `tsc`/`eslint` run, scoped to the files you pass. Read-only: never formats, fixes, or writes. Do NOT call this to verify or check files you just edited — diagnostics run automatically after every edit, so editing is never a trigger. Use ONLY when the user explicitly asks for diagnostics, or to inspect a reported error you have not yet seen.",
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
    const progress = (text: string) =>
      onUpdate?.({ content: [{ type: "text", text }], details: {} });

    const res = await callDriver<DiagResult>(
      ctx.cwd,
      "diagnostics",
      [files],
      signal,
      progress,
    );
    if (!res.ok) {
      return {
        content: [
          { type: "text", text: `LSP error: ${res.error ?? "unknown"}` },
        ],
        details: { success: false },
      };
    }

    const diags = [...(res.diagnostics ?? [])].sort((a, b) => {
      const s = sevRank[a.severity] - sevRank[b.severity];
      if (s !== 0) return s;
      const f = a.file.localeCompare(b.file);
      if (f !== 0) return f;
      return a.line - b.line;
    });

    const errors = diags.filter((d) => d.severity === "error").length;
    const warns = diags.filter((d) => d.severity === "warn").length;

    if (diags.length === 0) {
      return {
        content: [{ type: "text", text: "No diagnostics ✓" }],
        details: { success: true, count: 0, errors: 0, warns: 0 },
      };
    }

    const lines = [
      `${diags.length} diagnostic(s) (${errors} error, ${warns} warn):`,
    ];
    for (const d of diags) {
      const loc = displayPath(d.file, ctx.cwd);
      const src = d.source
        ? `${d.source}${d.code ? `(${d.code})` : ""}`
        : (d.code ?? "");
      lines.push(
        `  ${loc}:${d.line}:${d.col}  ${sevTag[d.severity]}  ${src ? `${src}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`,
      );
    }
    const t = truncateHead(lines.join("\n"), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let text = t.content;
    if (t.truncated) {
      text += `\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`;
    }
    return {
      content: [{ type: "text", text }],
      details: { success: true, count: diags.length, errors, warns },
    };
  },
});
