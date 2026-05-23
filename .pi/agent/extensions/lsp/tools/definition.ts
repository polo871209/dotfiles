import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
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

export const definitionTool = defineTool({
  name: "lsp_definition",
  label: "LSP Definition",
  description:
    "Jump to where a symbol is declared. Returns one or more file:line:col locations with a context line each.",
  promptSnippet: "Find where a symbol is declared",
  promptGuidelines: [
    "Use lsp_definition to locate where a symbol is declared before modifying it or reading wider source.",
    "Re-read the file to confirm line numbers before calling lsp_definition. Stale coordinates return 'No definition(s) found' silently.",
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
      "definition",
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
    return {
      content: [
        { type: "text", text: formatLocations(locs, ctx.cwd, "definition(s)") },
      ],
      details: { success: true, count: locs.length },
    };
  },
});
