import * as fs from "node:fs";
import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  withFileMutationQueue,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { run } from "../shared/exec";
import { restartDaemons } from "./nvim";
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

async function listWorkspaceFiles(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ files: string[]; totalCandidates: number }> {
  const candidates = (
    await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      signal,
      cwd,
    )
  ).stdout
    .split("\0")
    .filter(Boolean)
    .filter((rel) => {
      const base = rel.split("/").pop() ?? rel;
      if (
        [
          "package-lock.json",
          "bun.lock",
          "bun.lockb",
          "yarn.lock",
          "pnpm-lock.yaml",
          "Cargo.lock",
          "npm-shrinkwrap.json",
        ].includes(base)
      )
        return false;
      if (
        [
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
        ].includes(base.includes(".") ? base.split(".").pop()!.toLowerCase() : "")
      )
        return false;
      return true;
    });
  const files: string[] = [];
  for (const rel of candidates) {
    if (files.length >= 300) break;
    const abs = toAbs(rel, cwd);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 1_500_000) continue;
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
  action:
    AnchorAction | "document_symbols" | "diagnostics" | "rename" | "restart";
  file?: string;
  files?: string[];
  line?: number;
  symbol?: string;
  new_name?: string;
}

const err = (text: string): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details: { success: false },
  isError: true,
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
interface StatusFile {
  file: string;
  bufnr: number;
  clients: string[];
}
interface StatusResult extends DriverErr {
  files?: StatusFile[];
}

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
    (
      {
        hover: "hover",
        definition: "definition",
        references: "references",
        implementation: "implementation",
        type_definition: "type_definition",
      } satisfies Record<AnchorAction, string>
    )[action],
    [file, params.line, params.symbol ?? ""],
    signal,
    onUpdate,
    (res, cwd) => {
      const locs = res.locations ?? [];
      const t = capText(
        formatLocations(
          locs,
          cwd,
          (
            {
              hover: "hover",
              definition: "definition(s)",
              references: "reference(s)",
              implementation: "implementation(s)",
              type_definition: "type definition(s)",
            } satisfies Record<AnchorAction, string>
          )[action],
        ),
      );
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
        lines.push(
          `${"  ".repeat(s.depth + 1)}${s.kind} ${s.name}${s.detail ? `  ${s.detail}` : ""}  :${s.line}`,
        );
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
  return withFileMutationQueue(file, () =>
    withDriver<RenameResult>(
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
    ),
  );
}

async function runRestart(
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  const was = await restartDaemons();
  return withDriver<StatusResult>(
    ctx,
    "status",
    [],
    signal,
    onUpdate,
    (res) => {
      const files = res.files ?? [];
      return {
        text: `LSP restarted (${was ? "killed previous daemon" : "no daemon was running"}); fresh nvim ready with ${files.length} buffer(s).`,
        details: { restarted: was, buffers: files.length },
      };
    },
    "LSP restart failed",
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

  if (
    (!params.files || params.files.length === 0) &&
    (!params.file || params.file === "*")
  ) {
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
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  description:
    "Language-server navigation, symbol outlines, diagnostics, and rename. Actions: hover (type/docs), definition (canonical declaration), references (all uses), implementation (concrete implementors), type_definition (value type), document_symbols (file outline), diagnostics (read-only file/workspace check), rename (apply/save workspace edits), restart (respawn the LSP server).",
  promptSnippet:
    "Navigate symbols, inspect types, rename, or check diagnostics",
  promptGuidelines: [
    "Anchor at a current file:line for hover/definition/references/implementation/type_definition/rename; stale lines cause misses. symbol selects the column, or omit it for the first non-whitespace token.",
    "Use references before rename or a signature change to find every caller; rename applies and saves immediately across affected files.",
    "Prefer document_symbols to reading a whole file when locating a member or understanding structure.",
    "diagnostics with no file/files scans the capped workspace; post-edit diagnostics are automatic, so use this only on explicit request or a reported error.",
    "Use restart when results look stale or the server seems wedged (missing diagnostics after config/dependency changes, repeated timeouts), then retry the failed call once.",
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
        Type.Literal("restart"),
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
  outputSchema: Type.Object({
    success: Type.Boolean(),
    text: Type.String({ description: "The result as the model sees it" }),
    count: Type.Optional(
      Type.Number({
        description: "Locations, symbols, rename edits, or diagnostics",
      }),
    ),
    errors: Type.Optional(Type.Number()),
    warns: Type.Optional(Type.Number()),
    files: Type.Optional(
      Type.Number({ description: "Files a rename touched" }),
    ),
    truncated: Type.Optional(Type.Boolean()),
  }),
  async execute(_id, params, signal, onUpdate, ctx) {
    const result = await dispatch(params as LspParams, ctx, signal, onUpdate);
    const details = (result.details ?? {}) as Record<string, unknown>;
    const pick = (key: string) =>
      details[key] === undefined ? {} : { [key]: details[key] };
    const first = result.content[0];
    return {
      ...result,
      structuredContent: {
        success: details.success !== false && !result.isError,
        text: first?.type === "text" ? first.text : "",
        ...pick("count"),
        ...pick("errors"),
        ...pick("warns"),
        ...pick("files"),
        ...pick("truncated"),
      },
    };
  },
});

async function dispatch(
  p: LspParams,
  ctx: Parameters<Parameters<typeof defineTool>[0]["execute"]>[4],
  signal: AbortSignal | undefined,
  onUpdate: Parameters<Parameters<typeof defineTool>[0]["execute"]>[3],
): Promise<AgentToolResult<unknown>> {
  if (p.action === "restart") {
    return runRestart(ctx, signal, onUpdate);
  }
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
}
