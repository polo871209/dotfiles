// lsp-feedback — after edits, run nvim headless to format touched files,
// collect diagnostics, and show the result in a widget. LLM auto-fixes
// (errors + warnings) run by default; opt out with PI_LSP_FEEDBACK_AUTO_FIX=0.
import { complete } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type Severity = "error" | "warn" | "info" | "hint";
interface Diag {
  file: string;
  line: number;
  col: number;
  severity: Severity;
  source?: string;
  code?: string;
  message: string;
}
interface DriverResult {
  formatted: string[];
  diagnostics: Diag[];
}

const DRIVER = path.join(__dirname, "lsp-feedback.lua");
const NVIM_TIMEOUT_MS = 15_000;
const MAX_FILES = 25;
const MAX_LINES_OUT = 50;
const MAX_FIX_FILES = 5;
const MAX_FILE_BYTES = 64 * 1024;
const MARKER = "__LSP_FEEDBACK_JSON__";
const WIDGET_KEY = "lsp-feedback";
// Prefix each widget line with a thin vertical bar so the panel reads as a
// clean block without width-dependent borders. Lines are colored rosewater
// (catppuccin #f5e0dc) via a direct truecolor ANSI escape so the styling
// only affects this widget, not the rest of pi.
// `\x1b[2m` = faint/dim intensity (~50% brightness on most terminals incl.
// ghostty); combined with the rosewater truecolor it reads as a soft
// muted rose. `\x1b[22;39m` resets both intensity and fg.
const ROSE = "\x1b[2;38;2;245;224;220m";
const RESET = "\x1b[22;39m";
const BAR = `${ROSE}▎ `;
const rose = (s: string) => `${ROSE}${s}${RESET}`;
const AUTO_FIX = process.env.PI_LSP_FEEDBACK_AUTO_FIX !== "0";

const FIXER_SYSTEM = `Fix only the listed LSP/lint issues in the file. Change nothing else; preserve all other code, comments, and formatting exactly. If unsure, leave it. Output the full corrected file in one fenced code block. No prose.`;

const TRACKED_TOOLS = new Set(["edit", "write", "str_replace", "create"]);
const FIXABLE_SEVERITIES: ReadonlySet<Severity> = new Set(["error", "warn"]);

const isRebasing = (cwd: string): boolean => {
  let dir = cwd;
  for (let i = 0; i < 8; i++) {
    const gitDir = path.join(dir, ".git");
    if (fs.existsSync(gitDir)) {
      return (
        fs.existsSync(path.join(gitDir, "rebase-merge")) ||
        fs.existsSync(path.join(gitDir, "rebase-apply")) ||
        fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
        fs.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
};

const toAbs = (p: string, cwd: string): string =>
  path.isAbsolute(p) ? p : path.resolve(cwd, p);

const extractPath = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return;
  const i = input as Record<string, unknown>;
  for (const k of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = i[k];
    if (typeof v === "string" && v) return v;
  }
};

const runDriver = (
  files: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DriverResult | null> =>
  new Promise((resolve) => {
    const child = spawn(
      "nvim",
      ["--headless", ...files, "+luafile " + DRIVER],
      { cwd, stdio: ["ignore", "pipe", "pipe"], signal },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    const killer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, NVIM_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(killer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(killer);
      const idx = stdout.lastIndexOf(MARKER);
      if (idx < 0) {
        if (stderr.trim()) console.error("[lsp-feedback]", stderr.trim());
        return resolve(null);
      }
      const json = stdout.slice(idx + MARKER.length).trim();
      try {
        resolve(JSON.parse(json) as DriverResult);
      } catch {
        resolve(null);
      }
    });
  });

const sevTag: Record<Severity, string> = {
  error: "error",
  warn: "warn ",
  info: "info ",
  hint: "hint ",
};

const sevRank: Record<Severity, number> = {
  error: 0,
  warn: 1,
  info: 2,
  hint: 3,
};

const displayPath = (abs: string, cwd: string): string => {
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
  return rel;
};

const groupFixableByFile = (diags: Diag[]): Map<string, Diag[]> => {
  const m = new Map<string, Diag[]>();
  for (const d of diags) {
    if (!FIXABLE_SEVERITIES.has(d.severity)) continue;
    const arr = m.get(d.file) ?? [];
    arr.push(d);
    m.set(d.file, arr);
  }
  return m;
};

const extractCodeBlock = (text: string): string | null => {
  const m = text.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  if (m) return m[1];
  if (!/^\s*(I |Here|Sure|The |This )/i.test(text)) return text.trim();
  return null;
};

const runFixerLLM = async (
  file: string,
  content: string,
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  if (!ctx.model) return null;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) return null;

  const diagText = diags
    .map(
      (d) =>
        `${d.line}:${d.col}  ${d.source ? `${d.source}${d.code ? `(${d.code})` : ""}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`,
    )
    .join("\n");

  const userText = [
    `File: ${file}`,
    "",
    "Issues:",
    diagText,
    "",
    "```",
    content,
    "```",
  ].join("\n");

  try {
    const response = await complete(
      ctx.model,
      {
        systemPrompt: FIXER_SYSTEM,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userText }],
            timestamp: Date.now(),
          },
        ] as never,
      },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );
    if (response.stopReason === "aborted") return null;
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return extractCodeBlock(text);
  } catch {
    return null;
  }
};

const applyFixes = async (
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string[]> => {
  const targets = Array.from(groupFixableByFile(diags).entries()).slice(
    0,
    MAX_FIX_FILES,
  );
  const patched: string[] = [];

  for (const [file, errs] of targets) {
    let original: string;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      original = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const fixed = await runFixerLLM(file, original, errs, ctx, signal);
    if (!fixed || fixed === original) continue;
    if (fixed.length < Math.min(20, original.length / 4)) continue;
    try {
      fs.writeFileSync(file, fixed, "utf8");
      patched.push(file);
    } catch {
      /* ignore */
    }
  }
  return patched;
};

const buildWidgetLines = (
  r: DriverResult,
  cwd: string,
  fixedFiles: string[] = [],
  fixSkipped = false,
): string[] | null => {
  const diags = [...r.diagnostics].sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    const f = a.file.localeCompare(b.file);
    if (f !== 0) return f;
    return a.line - b.line;
  });
  const formatted = r.formatted.map((f) => displayPath(f, cwd));
  const fixed = fixedFiles.map((f) => displayPath(f, cwd));

  // Suppress notice when nothing actionable happened (pure format-only run).
  if (diags.length === 0 && fixed.length === 0) return null;

  const lines: string[] = [rose(`${BAR}lsp-feedback`)];
  if (fixed.length > 0) lines.push(`llm-fixed: ${fixed.join(", ")}`);
  if (formatted.length > 0) lines.push(`formatted: ${formatted.join(", ")}`);
  if (fixSkipped)
    lines.push("fixable issues found; run /lsp-fix to apply LLM fixes");
  if (diags.length > 0) {
    if (formatted.length > 0 || fixed.length > 0 || fixSkipped) lines.push("");
    lines.push(`${diags.length} diagnostic(s):`);
    const shown = diags.slice(0, MAX_LINES_OUT);
    for (const d of shown) {
      const loc = displayPath(d.file, cwd);
      const src = d.source
        ? `${d.source}${d.code ? `(${d.code})` : ""}`
        : (d.code ?? "");
      lines.push(
        `  ${loc}:${d.line}:${d.col}  ${sevTag[d.severity]}  ${src ? `${src}: ` : ""}${d.message.replace(/\s+/g, " ").trim()}`,
      );
    }
    if (diags.length > shown.length) {
      lines.push(`  … (+${diags.length - shown.length} more)`);
    }
  } else if (fixed.length > 0) {
    lines.push("all errors and warnings fixed ✓");
  }
  return lines.map((l, i) => (i === 0 ? l : rose(`${BAR}${l}`)));
};

export default function (pi: ExtensionAPI) {
  const touched = new Set<string>();
  let lastFiles: string[] = [];
  let reported = false;
  let cwd = process.cwd();

  const reset = () => {
    touched.clear();
    lastFiles = [];
    reported = false;
  };

  const runFeedback = async (
    files: string[],
    ctx: ExtensionContext,
    fix: boolean,
  ): Promise<void> => {
    const projectCwd = ctx.cwd ?? cwd;
    const first = await runDriver(
      files.slice(0, MAX_FILES),
      projectCwd,
      ctx.signal,
    );
    if (!first) return;

    const hasFixable = first.diagnostics.some((d) =>
      FIXABLE_SEVERITIES.has(d.severity),
    );
    let final: DriverResult = first;
    let fixedFiles: string[] = [];

    if (fix && hasFixable) {
      fixedFiles = await applyFixes(first.diagnostics, ctx, ctx.signal);
      if (fixedFiles.length > 0) {
        const second = await runDriver(fixedFiles, projectCwd, ctx.signal);
        if (second) {
          const patchedSet = new Set(fixedFiles);
          final = {
            formatted: Array.from(
              new Set([...first.formatted, ...second.formatted]),
            ),
            diagnostics: [
              ...first.diagnostics.filter((d) => !patchedSet.has(d.file)),
              ...second.diagnostics,
            ],
          };
        }
      }
    }

    const lines = buildWidgetLines(
      final,
      projectCwd,
      fixedFiles,
      hasFixable && !fix,
    );
    if (!lines) return;
    const overflow = files.length - Math.min(files.length, MAX_FILES);
    if (overflow > 0) {
      lines.splice(
        lines.length - 1,
        0,
        `  (skipped ${overflow} more file(s) over limit of ${MAX_FILES})`,
      );
    }
    // Pass a factory function so we bypass pi's 10-line cap on array-style
    // widgets (which truncates with "... (widget truncated)").
    ctx.ui?.setWidget?.(
      WIDGET_KEY,
      (_tui, _theme) => {
        const container = new Container();
        for (const line of lines) {
          container.addChild(new Text(line, 1, 0));
        }
        return container;
      },
      { placement: "aboveEditor" } as never,
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    reset();
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    reported = false;
    ctx.ui?.setWidget?.(WIDGET_KEY, undefined as never);
  });

  // biome-ignore lint/suspicious/noExplicitAny: tool_result event types vary across pi versions
  (pi as any).on("tool_result", async (event: any) => {
    if (!event || event.isError) return;
    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input ?? event.args);
    if (!p) return;
    const abs = toAbs(p, cwd);
    if (!fs.existsSync(abs)) return;
    touched.add(abs);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (reported || touched.size === 0) return;
    if (isRebasing(ctx.cwd ?? cwd)) return;
    lastFiles = Array.from(touched);
    touched.clear();
    reported = true;
    await runFeedback(lastFiles, ctx, AUTO_FIX);
  });

  pi.registerCommand?.("lsp-now", {
    description: "Run lsp-feedback diagnostics on recently edited files",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const files = touched.size > 0 ? Array.from(touched) : lastFiles;
      if (files.length === 0) return;
      await runFeedback(files, ctx, false);
    },
  });

  pi.registerCommand?.("lsp-fix", {
    description: "Run lsp-feedback and apply LLM fixes to recent diagnostics",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const files = touched.size > 0 ? Array.from(touched) : lastFiles;
      if (files.length === 0) return;
      await runFeedback(files, ctx, true);
    },
  });
}
