// lsp-feedback — after edits, route touched files through the persistent
// nvim owned by extensions/lsp/ to format, apply safe code-actions, and
// collect diagnostics. Widget renders the result. LLM auto-fixes (errors +
// warnings) run unconditionally.
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callLua, isRunning, loadLua } from "./lsp/nvim";
import { displayPath, toAbs } from "./lsp/utils";
import { sideChannelComplete } from "./shared/llm";
import { barWidget } from "./shared/widget";

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

const FEEDBACK_LUA = path.join(import.meta.dirname, "lsp-feedback.lua");
const LOG_FILE = path.join(os.tmpdir(), "pi-lsp-feedback.log");
const logDriver = (msg: string) => {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] ${msg}\n`,
      "utf8",
    );
  } catch {
    /* best effort */
  }
};

// Load _G.PiFeedback into the shared nvim once per session.
// Re-check isRunning() so /lsp-restart (from lsp/index.ts) forces a reload
// of _G.PiFeedback into the fresh nvim.
let feedbackLoaded = false;
const ensureFeedbackLoaded = async (cwd: string): Promise<void> => {
  if (feedbackLoaded && isRunning()) return;
  const src = fs.readFileSync(FEEDBACK_LUA, "utf8");
  await loadLua(cwd, src);
  feedbackLoaded = true;
};

// Lua side enforces PER_FILE_BUDGET_MS = 4500 + ~1s settle. Match here
// with headroom so the hard cap fires only on a wedged nvim.
const PER_FILE_BUDGET_MS = 5_500;
const BASE_TIMEOUT_MS = 3_000;
const nvimCallTimeoutMs = (fileCount: number): number =>
  BASE_TIMEOUT_MS + Math.max(1, fileCount) * PER_FILE_BUDGET_MS;
const MAX_FILES = 25;
const MAX_LINES_OUT = 50;
const MAX_FIX_FILES = 5;
const MAX_FILE_BYTES = 64 * 1024;
const WIDGET_KEY = "lsp-feedback";
const AUTO_FIX = true;

const FIXER_SYSTEM = `Fix only the listed LSP/lint issues in the file. Change nothing else; preserve all other code, comments, and formatting exactly. If unsure, leave it. Output the full corrected file in one fenced code block. No prose.`;

const TRACKED_TOOLS = new Set(["edit", "write", "str_replace", "create"]);
const FIXABLE_SEVERITIES: ReadonlySet<Severity> = new Set(["error", "warn"]);

const GIT_WALK_MAX_DEPTH = 8;
const isRebasing = (cwd: string): boolean => {
  let dir = cwd;
  for (let i = 0; i < GIT_WALK_MAX_DEPTH; i++) {
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

// Skip throwaway scratch paths: /tmp, /var/folders/... (macOS $TMPDIR),
// /private/tmp, /private/var/folders/...
const SKIP_PREFIXES = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
  `${os.tmpdir()}${path.sep}`,
];
const isScratchPath = (abs: string): boolean => {
  const real = (() => {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  })();
  return SKIP_PREFIXES.some((p) => abs.startsWith(p) || real.startsWith(p));
};

// Build-artifact / vendored dirs we never want to feed to LSP. Cheap path
// segment match — avoids spawning `git check-ignore` per file.
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".git",
]);
const isIgnoredPath = (abs: string, cwd: string): boolean => {
  const rel = path.relative(cwd, abs);
  if (!rel || rel.startsWith("..")) return false;
  return rel.split(path.sep).some((seg) => IGNORED_SEGMENTS.has(seg));
};

const extractPath = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return;
  const i = input as Record<string, unknown>;
  for (const k of ["path", "file_path", "filePath", "filename", "file"]) {
    const v = i[k];
    if (typeof v === "string" && v) return v;
  }
};

const runDriver = async (
  files: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<DriverResult | null> => {
  try {
    await ensureFeedbackLoaded(cwd);
    // Hard cap via AbortSignal in case nvim wedges.
    const timeoutSignal = AbortSignal.timeout(nvimCallTimeoutMs(files.length));
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    return await callLua<DriverResult>(
      cwd,
      "return PiFeedback.run(...)",
      [files],
      combined,
    );
  } catch (e) {
    logDriver(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

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

// Require a fenced code block. Bare prose is rejected — too easy for a
// short "no issues found" reply to clobber the source file.
const extractCodeBlock = (text: string): string | null => {
  const m = text.match(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/);
  return m ? m[1]! : null;
};

const runFixerLLM = async (
  file: string,
  content: string,
  diags: Diag[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
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

  const r = await sideChannelComplete(ctx, {
    systemPrompt: FIXER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userText }],
        timestamp: Date.now(),
      },
    ],
    signal,
  });
  if (!r.ok) return null;
  return extractCodeBlock(r.text);
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
    // Guard against truncated LLM output clobbering a working file.
    // Require >=90% length retention AND matching brace/paren counts.
    if (fixed.length < original.length * 0.9) continue;
    const countChar = (s: string, c: string) => s.split(c).length - 1;
    if (
      countChar(fixed, "{") !== countChar(original, "{") ||
      countChar(fixed, "}") !== countChar(original, "}") ||
      countChar(fixed, "(") !== countChar(original, "(") ||
      countChar(fixed, ")") !== countChar(original, ")")
    )
      continue;
    try {
      // No backup — user has git. Sanity gates above (length floor,
      // identity check) catch obvious bad outputs.
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

  const lines: string[] = ["lsp-feedback"];
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
  return lines;
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
    ctx.ui.setWidget(WIDGET_KEY, barWidget(lines), {
      placement: "aboveEditor",
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    reset();
    // Warm nvim + feedback lua in the background so the first edit skips spawn
    // + init.lua + LSP-attach. Deferred a tick to keep the sync prefix (file
    // read + spawn syscall) off pi's startup path.
    setTimeout(() => {
      void ensureFeedbackLoaded(cwd).catch(() => {});
    }, 0);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    reported = false;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });

  pi.on("tool_result", async (event) => {
    if (event.isError) return;
    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input);
    if (!p) return;
    const abs = toAbs(p, cwd);
    if (!fs.existsSync(abs)) return;
    if (isScratchPath(abs)) return;
    if (isIgnoredPath(abs, cwd)) return;
    touched.add(abs);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (reported || touched.size === 0) return;
    if (isRebasing(ctx.cwd ?? cwd)) return;
    lastFiles = Array.from(touched);
    touched.clear();
    reported = true;
    // Fire-and-forget: return immediately so pi marks the turn idle.
    // The widget appears when the background work finishes.
    void runFeedback(lastFiles, ctx, AUTO_FIX).catch((e) => {
      console.error(
        "[lsp-feedback] background run failed:",
        e instanceof Error ? e.message : String(e),
      );
    });
  });
}
