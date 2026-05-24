import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  formatLocations,
  runNavTool,
  type DriverErr,
  type LspLocation,
} from "../utils";

interface DriverLocResult extends DriverErr {
  locations?: LspLocation[];
}

export const definitionTool = defineTool({
  name: "lsp_definition",
  label: "LSP Definition",
  description:
    "Jump to canonical declaration of ONE symbol at file:line (requires anchor; resolves re-exports, overloads). For name-only search without an anchor, use codegraph_search or grep first to get a location, then this for the canonical def.",
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
    return runNavTool<DriverLocResult>(
      "definition",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        return {
          text: formatLocations(locs, cwd, "definition(s)"),
          details: { count: locs.length },
        };
      },
    );
  },
});
