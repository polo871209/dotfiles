import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  anchorGuidelines,
  formatLocations,
  runNavTool,
  type DriverErr,
  type LspLocation,
} from "../utils";

interface DriverLocResult extends DriverErr {
  locations?: LspLocation[];
}

export const referencesTool = defineTool({
  name: "lsp_references",
  label: "LSP References",
  description:
    "Find every USE of ONE symbol at file:line (requires anchor). More reliable than grep for usage finding — no false hits from substring matches, and follows re-exports. codegraph_search returns DEFINITIONS not uses — for 'where is X called' THIS is the tool.",
  promptSnippet: "List all places that reference a symbol",
  promptGuidelines: anchorGuidelines(
    "Use lsp_references before renaming or changing a function's signature to find every caller.",
  ),
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
      "references",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        const full = formatLocations(locs, cwd, "reference(s)");
        const t = truncateHead(full, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });
        let text = t.content;
        if (t.truncated) {
          text += `\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`;
        }
        return {
          text,
          details: { count: locs.length, truncated: t.truncated },
        };
      },
    );
  },
});
