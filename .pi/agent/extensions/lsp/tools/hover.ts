import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { callDriver } from "../nvim";
import { normalizeAtPath, toAbs } from "../utils";

interface DriverHoverResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export const hoverTool = defineTool({
  name: "lsp_hover",
  label: "LSP Hover",
  description:
    "Type signature + docs for ONE symbol at file:line (requires anchor). Use when you already have a location and want type info without reading source. codegraph_* tools do NOT return type signatures — this is the only way.",
  promptSnippet: "Read a symbol's type and docs without opening the file",
  promptGuidelines: [
    "Use lsp_hover to inspect a symbol's type or signature without reading the whole source file.",
    "Re-read the file to confirm line numbers before calling lsp_hover. Stale coordinates return 'No hover information' silently.",
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
    const res = await callDriver<DriverHoverResult>(
      ctx.cwd,
      "hover",
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
    const text = res.text?.trim() || "No hover information";
    return {
      content: [{ type: "text", text }],
      details: { success: true, file, line: params.line },
    };
  },
});
