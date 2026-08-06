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

export const definitionTool = defineTool({
  name: "lsp_definition",
  label: "LSP Definition",
  description:
    "Jump to canonical declaration of ONE symbol at file:line (requires anchor; resolves re-exports, overloads). For name-only search without an anchor, use grep first to get a location, then this for the canonical def.",
  promptSnippet: "Find where a symbol is declared",
  promptGuidelines: anchorGuidelines(
    "Use lsp_definition to locate where a symbol is declared before modifying it or reading wider source.",
  ),
  parameters: anchorParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    return runNavTool<DriverLocResult>(
      "definition",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        const t = capText(formatLocations(locs, cwd, "definition(s)"));
        return {
          text: t.text,
          details: { count: locs.length, truncated: t.truncated },
        };
      },
    );
  },
});
