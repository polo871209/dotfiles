import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { callDriver } from "../nvim";
import {
  anchorGuidelines,
  displayPath,
  normalizeAtPath,
  toAbs,
  type DriverErr,
} from "../utils";

interface RenameResult extends DriverErr {
  files?: string[];
  count?: number;
}

export const renameTool = defineTool({
  name: "lsp_rename",
  label: "LSP Rename",
  description:
    "Rename ONE symbol at file:line everywhere across the project (requires anchor). Workspace-wide LSP refactor — updates every reference in every file and writes changed files to disk. Symbol-identity precise: no text-match false hits, handles imports/re-exports/overloads. Use this instead of grep+edit when renaming a function, class, variable, or type.",
  promptSnippet: "Rename a symbol across the whole project",
  promptGuidelines: [
    ...anchorGuidelines(
      "Anchor at the symbol's definition or any usage; new_name replaces it everywhere it resolves.",
    ),
    "Applies across the whole project and changes files — review with git diff after; undo via git if wrong.",
  ],
  parameters: Type.Object({
    file: Type.String({ description: "Absolute or cwd-relative file path." }),
    line: Type.Number({ minimum: 1, description: "1-indexed line number." }),
    new_name: Type.String({ description: "New name for the symbol." }),
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
    const res = await callDriver<RenameResult>(
      ctx.cwd,
      "rename",
      [file, params.line, params.symbol ?? "", params.new_name],
      signal,
      progress,
    );
    if (!res.ok) {
      return {
        content: [
          { type: "text", text: `LSP rename error: ${res.error ?? "unknown"}` },
        ],
        details: { success: false },
      };
    }
    const files = res.files ?? [];
    const list = files.map((f) => `  ${displayPath(f, ctx.cwd)}`).join("\n");
    const text =
      files.length === 0
        ? "Rename returned no changes"
        : `Renamed to '${params.new_name}' across ${files.length} file(s):\n${list}`;
    return {
      content: [{ type: "text", text }],
      details: { success: true, count: files.length },
    };
  },
});
