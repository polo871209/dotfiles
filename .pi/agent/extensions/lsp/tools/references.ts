import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { callDriver } from "../nvim";
import {
  formatLocations,
  normalizeAtPath,
  toAbs,
  type LspLocation,
} from "../utils";

interface DriverLocResult {
  ok: boolean;
  locations?: LspLocation[];
  error?: string;
}

export const referencesTool = defineTool({
  name: "lsp_references",
  label: "LSP References",
  description:
    "Find every usage of a symbol across the project (includes the declaration site itself). Output is truncated when large.",
  promptSnippet: "List all places that reference a symbol",
  promptGuidelines: [
    "Use lsp_references before renaming or changing a function's signature to find every caller.",
    "Re-read the file to confirm line numbers before calling lsp_references. Stale coordinates return 'No reference(s) found' silently.",
  ],
  parameters: Type.Object({
    file: Type.String({ description: "Absolute or cwd-relative file path." }),
    line: Type.Number({
      minimum: 1,
      description: "1-indexed line number.",
    }),
    symbol: Type.Optional(
      Type.String({
        description:
          "Substring on the line to anchor the column. Omit to use the first non-whitespace token.",
      }),
    ),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const file = toAbs(normalizeAtPath(params.file), ctx.cwd);
    const progress = (text: string) =>
      onUpdate?.({ content: [{ type: "text", text }], details: {} });
    const res = await callDriver<DriverLocResult>(
      ctx.cwd,
      "references",
      [file, params.line, params.symbol ?? ""],
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
    const locs = res.locations ?? [];
    const full = formatLocations(locs, ctx.cwd, "reference(s)");
    const t = truncateHead(full, {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    let text = t.content;
    if (t.truncated) {
      text += `\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`;
    }
    return {
      content: [{ type: "text", text }],
      details: { success: true, count: locs.length, truncated: t.truncated },
    };
  },
});
