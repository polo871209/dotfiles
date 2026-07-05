import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  displayPath,
  normalizeAtPath,
  toAbs,
  withDriver,
  type DriverErr,
} from "../utils";

interface DocSymbol {
  name: string;
  kind: string;
  line: number;
  col: number;
  depth: number;
  detail?: string;
}
interface DocResult extends DriverErr {
  symbols?: DocSymbol[];
}

const cap = (text: string): string => {
  const t = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return t.truncated
    ? `${t.content}\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`
    : t.content;
};

export const documentSymbolsTool = defineTool({
  name: "lsp_document_symbols",
  label: "LSP Document Symbols",
  description:
    "Outline of every symbol (classes, functions, methods, fields, etc.) declared in a file — the file's structure without reading the whole source. Use to locate a member or grasp a file's shape before diving in.",
  promptSnippet: "Outline a file's symbols without reading it",
  promptGuidelines: [
    "Prefer over reading a whole file when you only need to find a member or understand structure.",
  ],
  parameters: Type.Object({
    file: Type.String({ description: "Absolute or cwd-relative file path." }),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const p = params as { file: string };
    const file = toAbs(normalizeAtPath(p.file), ctx.cwd);
    return withDriver<DocResult>(
      ctx,
      "document_symbols",
      [file],
      signal,
      onUpdate,
      (res, cwd) => {
        const syms = res.symbols ?? [];
        if (syms.length === 0) {
          return { text: "No symbols found", details: { count: 0 } };
        }
        const lines = [
          `${syms.length} symbol(s) in ${displayPath(file, cwd)}:`,
        ];
        for (const s of syms) {
          const indent = "  ".repeat(s.depth + 1);
          const detail = s.detail ? `  ${s.detail}` : "";
          lines.push(`${indent}${s.kind} ${s.name}${detail}  :${s.line}`);
        }
        return { text: cap(lines.join("\n")), details: { count: syms.length } };
      },
    );
  },
});
