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

export const implementationTool = defineTool({
  name: "lsp_implementation",
  label: "LSP Implementation",
  description:
    "Find concrete implementations of the interface / abstract method / symbol at file:line (requires anchor). Use when sitting on an interface or abstract declaration and you need the real implementors. Differs from lsp_definition (goes to the declaration, not the implementors).",
  promptSnippet: "Find implementations of an interface/abstract symbol",
  promptGuidelines: anchorGuidelines(
    "Anchor on an interface, abstract method, or trait member; returns the concrete implementors.",
  ),
  parameters: anchorParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    return runNavTool<DriverLocResult>(
      "implementation",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        const t = capText(formatLocations(locs, cwd, "implementation(s)"));
        return {
          text: t.text,
          details: { count: locs.length, truncated: t.truncated },
        };
      },
    );
  },
});

export const typeDefinitionTool = defineTool({
  name: "lsp_type_definition",
  label: "LSP Type Definition",
  description:
    "Jump to the TYPE declaration of the symbol at file:line (requires anchor) — e.g. from a variable to the interface/class/type it is typed as. Differs from lsp_definition, which goes to the value/declaration site.",
  promptSnippet: "Jump from a value to the type it's declared as",
  promptGuidelines: anchorGuidelines(
    "Anchor on a variable, parameter, or field; returns where its TYPE is declared.",
  ),
  parameters: anchorParams,
  async execute(_id, params, signal, onUpdate, ctx) {
    return runNavTool<DriverLocResult>(
      "type_definition",
      params,
      ctx,
      signal,
      onUpdate,
      (res, cwd) => {
        const locs = res.locations ?? [];
        const t = capText(formatLocations(locs, cwd, "type definition(s)"));
        return {
          text: t.text,
          details: { count: locs.length, truncated: t.truncated },
        };
      },
    );
  },
});
