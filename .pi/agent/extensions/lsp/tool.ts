// Single consolidated LSP tool: one `action` enum instead of 7 separate
// tools. Same 7 ops, same driver calls — this only cuts the repeated
// file/line/symbol schema + boilerplate description sent on every turn.
import * as fs from "node:fs";
import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { run } from "../shared/exec";
import {
  capText,
  displayPath,
  formatDiagLine,
  formatLocations,
  normalizeAtPath,
  sortDiagnostics,
  toAbs,
  withDriver,
  type Diag,
  type DriverErr,
  type LspLocation,
} from "./utils";

// Repo-wide diagnostics (action=diagnostics, no file/files): enumerate
// git-tracked + untracked-but-not-ignored files (git already knows what to
// skip — node_modules, build output, etc. — so this never reimplements
// ignore-file logic), drop extensions no LSP client ever attaches to, and
// cap the batch so one call can't wedge nvim opening thousands of buffers.
const WORKSPACE_DIAG_MAX_FILES = 300;
const WORKSPACE_DIAG_MAX_BYTES = 1_500_000;
const SKIP_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "svg",
  "bmp",
  "icns",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "zip",
  "tar",
  "gz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "pdf",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "webm",
  "lock",
  "log",
]);
const SKIP_BASENAMES = new Set([
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "npm-shrinkwrap.json",
]);

async function listWorkspaceFiles(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ files: string[]; totalCandidates: number }> {
  const res = await run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    signal,
    cwd,
  );
  const all = res.stdout.split("\0").filter(Boolean);
  const candidates = all.filter((rel) => {
    const base = rel.split("/").pop() ?? rel;
    if (SKIP_BASENAMES.has(base)) return false;
    const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
    if (SKIP_EXTS.has(ext)) return false;
    return true;
  });
  const files: string[] = [];
  for (const rel of candidates) {
    if (files.length >= WORKSPACE_DIAG_MAX_FILES) break;
    const abs = toAbs(rel, cwd);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > WORKSPACE_DIAG_MAX_BYTES) continue;
    } catch {
      continue;
    }
    files.push(abs);
  }
  return { files, totalCandidates: candidates.length };
}

const ANCHOR_ACTIONS = [
  "hover",
  "definition",
  "references",
  "implementation",
  "type_definition",
] as const;
type AnchorAction = (typeof ANCHOR_ACTIONS)[number];

interface LspParams {
  action: AnchorAction | "document_symbols" | "diagnostics" | "rename";
  file?: string;
  files?: string[];
  line?: number;
  symbol?: string;
  new_name?: string;
}

const err = (text: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: { success: false },
});

const cap = (text: string): string => {
  const t = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  return t.truncated
    ? `${t.content}\n\n[truncated: shown ${t.outputLines}/${t.totalLines} lines]`
    : t.content;
};

interface DriverLocResult extends DriverErr {
  locations?: LspLocation[];
}
interface DriverHoverResult extends DriverErr {
  text?: string;
}
interface DiagResult extends DriverErr {
  diagnostics?: Diag[];
}
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
interface RenameFileEdit {
  file: string;
  edits: number;
}
interface RenameResult extends DriverErr {
  files?: RenameFileEdit[];
  edit_count?: number;
}

const ANCHOR_LABEL: Record<AnchorAction, string> = {
  hover: "hover",
  definition: "definition(s)",
  references: "reference(s)",
  implementation: "implementation(s)",
  type_definition: "type definition(s)",
};

const ANCHOR_DRIVER_FN: Record<AnchorAction, string> = {
  hover: "hover",
  definition: "definition",
  references: "references",
  implementation: "implementation",
  type_definition: "type_definition",
};

async function runAnchor(
  action: AnchorAction,
  params: LspParams,
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  if (!params.file) return err(`LSP error: action "${action}" requires file`);
  if (!params.line) return err(`LSP error: action "${action}" requires line`);
  const file = toAbs(normalizeAtPath(params.file), ctx.cwd);

  if (action === "hover") {
    return withDriver<DriverHoverResult>(
      ctx,
      "hover",
      [file, params.line, params.symbol ?? ""],
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
  }

  return withDriver<DriverLocResult>(
    ctx,
    ANCHOR_DRIVER_FN[action],
    [file, params.line, params.symbol ?? ""],
    signal,
    onUpdate,
    (res, cwd) => {
      const locs = res.locations ?? [];
      const t = capText(formatLocations(locs, cwd, ANCHOR_LABEL[action]));
      return {
        text: t.text,
        details: { count: locs.length, truncated: t.truncated },
      };
    },
  );
}

async function runDocumentSymbols(
  params: LspParams,
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  if (!params.file)
    return err('LSP error: action "document_symbols" requires file');
  const file = toAbs(normalizeAtPath(params.file), ctx.cwd);
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
      const lines = [`${syms.length} symbol(s) in ${displayPath(file, cwd)}:`];
      for (const s of syms) {
        const indent = "  ".repeat(s.depth + 1);
        const detail = s.detail ? `  ${s.detail}` : "";
        lines.push(`${indent}${s.kind} ${s.name}${detail}  :${s.line}`);
      }
      return { text: cap(lines.join("\n")), details: { count: syms.length } };
    },
  );
}

async function runRename(
  params: LspParams,
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  if (!params.file) return err('LSP error: action "rename" requires file');
  if (!params.line) return err('LSP error: action "rename" requires line');
  if (!params.new_name)
    return err('LSP error: action "rename" requires new_name');
  const file = toAbs(normalizeAtPath(params.file), ctx.cwd);
  return withDriver<RenameResult>(
    ctx,
    "rename",
    [file, params.line, params.symbol ?? "", params.new_name],
    signal,
    onUpdate,
    (res, cwd) => {
      const files = res.files ?? [];
      if (files.length === 0) {
        return { text: "Rename returned no edits", details: { count: 0 } };
      }
      const lines = [
        `Renamed ${res.edit_count ?? 0} edit(s) across ${files.length} file(s):`,
      ];
      for (const f of files) {
        lines.push(`  ${displayPath(f.file, cwd)}  (${f.edits} edit(s))`);
      }
      return {
        text: cap(lines.join("\n")),
        details: { count: res.edit_count ?? 0, files: files.length },
      };
    },
  );
}

async function runDiagnostics(
  params: LspParams,
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  let files: string[];
  let workspaceNote = "";

  const workspaceMode =
    (!params.files || params.files.length === 0) &&
    (!params.file || params.file === "*");

  if (workspaceMode) {
    const { files: wsFiles, totalCandidates } = await listWorkspaceFiles(
      ctx.cwd,
      signal,
    );
    files = wsFiles;
    if (files.length === 0) {
      return err("LSP error: no workspace files found (not a git repo?)");
    }
    if (totalCandidates > files.length) {
      workspaceNote = `[workspace: showing ${files.length}/${totalCandidates} files]\n\n`;
    }
  } else if (params.files && params.files.length > 0) {
    files = params.files.map((f) => toAbs(normalizeAtPath(f), ctx.cwd));
  } else {
    files = [toAbs(normalizeAtPath(params.file!), ctx.cwd)];
  }

  return withDriver<DiagResult>(
    ctx,
    "diagnostics",
    [files],
    signal,
    onUpdate,
    (res, cwd) => {
      const diags = sortDiagnostics(res.diagnostics ?? []);
      const errors = diags.filter((d) => d.severity === "error").length;
      const warns = diags.filter((d) => d.severity === "warn").length;

      if (diags.length === 0) {
        return {
          text: `${workspaceNote}No diagnostics ✓`,
          details: { count: 0, errors: 0, warns: 0 },
        };
      }

      const lines = [
        `${diags.length} diagnostic(s) (${errors} error, ${warns} warn):`,
      ];
      for (const d of diags) lines.push(formatDiagLine(d, cwd));
      return {
        text: cap(`${workspaceNote}${lines.join("\n")}`),
        details: { count: diags.length, errors, warns },
      };
    },
  );
}

export const lspTool = defineTool({
  name: "lsp",
  label: "LSP",
  description:
    "Language-server navigation, symbol outlines, diagnostics, and rename. Actions: hover (type/docs), definition (canonical declaration), references (all uses), implementation (concrete implementors), type_definition (value type), document_symbols (file outline), diagnostics (read-only file/workspace check), rename (apply/save workspace edits).",
  promptSnippet:
    "Navigate symbols, inspect types, rename, or check diagnostics",
  promptGuidelines: [
    "Anchor at a current file:line for hover/definition/references/implementation/type_definition/rename; stale lines cause misses. symbol selects the column, or omit it for the first non-whitespace token.",
    "Use references before rename or a signature change to find every caller; rename applies and saves immediately across affected files.",
    "Prefer document_symbols to reading a whole file when locating a member or understanding structure.",
    "diagnostics with no file/files scans the capped workspace; post-edit diagnostics are automatic, so use this only on explicit request or a reported error.",
  ],
  parameters: Type.Object({
    action: Type.Union(
      [
        Type.Literal("hover"),
        Type.Literal("definition"),
        Type.Literal("references"),
        Type.Literal("implementation"),
        Type.Literal("type_definition"),
        Type.Literal("document_symbols"),
        Type.Literal("diagnostics"),
        Type.Literal("rename"),
      ],
      { description: "Which LSP operation to run." },
    ),
    file: Type.Optional(
      Type.String({
        description:
          'Abs or cwd-relative. Required for anchor/document_symbols/rename; diagnostics accepts file, files, or neither (or "*") for workspace.',
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Abs or cwd-relative paths, for action=diagnostics on specific files. Omit both file and files for repo-wide diagnostics.",
      }),
    ),
    line: Type.Optional(
      Type.Number({
        minimum: 1,
        description:
          "1-indexed line; required for hover/definition/references/implementation/type_definition/rename.",
      }),
    ),
    symbol: Type.Optional(
      Type.String({
        description:
          "Substring on the line to anchor the column. Omit to use the first non-whitespace token.",
      }),
    ),
    new_name: Type.Optional(
      Type.String({ description: "New name; required for action=rename." }),
    ),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const p = params as LspParams;
    if (p.action === "rename") {
      return runRename(p, ctx, signal, onUpdate);
    }
    if ((ANCHOR_ACTIONS as readonly string[]).includes(p.action)) {
      return runAnchor(p.action as AnchorAction, p, ctx, signal, onUpdate);
    }
    if (p.action === "document_symbols") {
      return runDocumentSymbols(p, ctx, signal, onUpdate);
    }
    if (p.action === "diagnostics") {
      return runDiagnostics(p, ctx, signal, onUpdate);
    }
    return err(`LSP error: unknown action "${p.action}"`);
  },
});
