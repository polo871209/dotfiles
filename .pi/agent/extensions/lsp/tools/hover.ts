import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  anchorGuidelines,
  anchorParams,
  capText,
  runNavTool,
  type DriverErr,
} from "../utils";

interface DriverHoverResult extends DriverErr {
  text?: string;
}

export const hoverTool = defineTool({
  name: "lsp_hover",
  label: "LSP Hover",
  description:
    "Type signature + docs for ONE symbol at file:line (requires anchor).",
  promptSnippet: "Read a symbol's type and docs without opening the file",
  promptGuidelines: anchorGuidelines(
    "Use lsp_hover to inspect a symbol's type or signature without reading the whole source file.",
  ),
  parameters: anchorParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    return runNavTool<DriverHoverResult>(
      "hover",
      params,
      ctx,
      signal,
      onUpdate,
      (res) => {
        const t = capText(res.text?.trim() || "No hover information");
        return {
          text: t.text,
          details: { line: params.line, truncated: t.truncated },
        };
      },
    );
  },
});
