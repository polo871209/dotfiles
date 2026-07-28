import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  anchorGuidelines,
  anchorParams,
  capText,
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
    "Find every USE of ONE symbol at file:line (requires anchor). More reliable than grep for usage finding — no false hits from substring matches, and follows re-exports. For 'where is X called' this is the tool, not codegraph_search.",
  promptSnippet: "List all places that reference a symbol",
  promptGuidelines: anchorGuidelines(
    "Use lsp_references before renaming or changing a function's signature to find every caller.",
  ),
  parameters: anchorParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    return runNavTool<DriverLocResult>(
      "references",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        const t = capText(formatLocations(locs, cwd, "reference(s)"));
        return {
          text: t.text,
          details: { count: locs.length, truncated: t.truncated },
        };
      },
    );
  },
});
