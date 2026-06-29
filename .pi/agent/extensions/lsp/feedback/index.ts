// Post-edit feedback pipeline. Two passes by nature:
//   - Inline (per edit, tool_result): format-only, fast. The formatted bytes
//     are folded back into the agent's own edit result so its view stays in
//     sync with disk — no surprise re-read, no extra context entry.
//   - Batched (turn end, agent_end): run the staged fix pipeline (pipeline.ts)
//     off-thread — format, diagnose, deterministic LSP code-fix, then LLM fix
//     only for surviving errors/warnings; when a fix rewrites a file, inject a
//     compact diff once so the next edit targets current bytes. Widget renders
//     the result; leftovers notify.
//
// registerFeedback(pi) is called from lsp/index.ts — this is part of the lsp
// extension (shares its nvim), not a standalone one.
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { displayPath, toAbs } from "../utils";
import { barWidget } from "../../shared/widget";
import {
  ensureFeedbackLoaded,
  formatFile,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "./driver";
import { runFixPipeline } from "./pipeline";
import { LLM_TARGET_SEVERITIES } from "./llm-fix";
import { changeNote } from "./diff";
import { buildWidgetLines } from "./widget";

const WIDGET_KEY = "lsp-feedback";
// Background auto-fix default. Overridable at launch via `--lsp-fix=false`;
// `/lsp-fix` then toggles it per session.
const AUTO_FIX_FLAG = "lsp-fix";
const TRACKED_TOOLS = new Set(["edit", "write", "str_replace", "create"]);

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

export function registerFeedback(pi: ExtensionAPI): void {
  pi.registerFlag(AUTO_FIX_FLAG, {
    description: "Background LSP auto-fix after edits (toggle with /lsp-fix)",
    type: "boolean",
    default: true,
  });

  const touched = new Set<string>();
  let reported = false;
  let autoFix = true;
  let cwd = process.cwd();

  const reset = () => {
    touched.clear();
    reported = false;
  };

  const runFeedback = async (
    files: string[],
    ctx: ExtensionContext,
    fix: boolean,
  ): Promise<void> => {
    const projectCwd = ctx.cwd ?? cwd;
    const result = await runFixPipeline(
      files,
      projectCwd,
      ctx,
      ctx.signal,
      fix,
    );
    if (!result) return;
    const { final, fixedFiles, fixResults, hadFixable } = result;

    const lines = buildWidgetLines(
      final,
      projectCwd,
      fixedFiles,
      hadFixable && !fix,
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

    // Nudge so unfixed issues don't sit silently in the widget — the auto-fix
    // couldn't (or wouldn't) resolve these; go check them.
    const unfixed = final.diagnostics.filter((d) =>
      LLM_TARGET_SEVERITIES.has(d.severity),
    ).length;
    if (unfixed > 0) {
      ctx.ui.notify(
        `lsp-feedback: ${unfixed} unfixed issue(s) — check the widget`,
        "warning",
      );
    }

    // Auto-fix rewrote files behind the agent (async, between turns). Surface a
    // compact diff once so the next edit targets current bytes instead of
    // forcing a full-file re-read.
    for (const fr of fixResults) {
      let after: string;
      try {
        after = fs.readFileSync(fr.file, "utf8");
      } catch {
        continue;
      }
      if (after === fr.before) continue;
      const text = changeNote(
        fr.before,
        after,
        displayPath(fr.file, projectCwd),
        "auto-fixed",
      );
      try {
        pi.sendMessage(
          { customType: "lsp-feedback-fix", content: text, display: false },
          { deliverAs: "nextTurn" },
        );
      } catch {
        /* best effort */
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    autoFix = pi.getFlag(AUTO_FIX_FLAG) !== false;
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

  // Format one file in place, register it for the batched diagnostics pass, and
  // return a note describing the format delta (undefined if skipped/unchanged).
  const processFile = async (abs: string): Promise<string | undefined> => {
    if (!fs.existsSync(abs)) return;
    if (isScratchPath(abs)) return;
    if (isIgnoredPath(abs, cwd)) return;
    touched.add(abs);
    try {
      const before = fs.readFileSync(abs, "utf8");
      if (Buffer.byteLength(before) > MAX_FILE_BYTES) return;
      if (!(await formatFile(abs, cwd))) return;
      const after = fs.readFileSync(abs, "utf8");
      if (after === before) return;
      return changeNote(before, after, displayPath(abs, cwd), "auto-formatted");
    } catch {
      return;
    }
  };

  // Inline format-on-save: format each touched file and fold the deltas into
  // the agent's own tool result, keeping its view synced to disk (no re-read)
  // without a separate context entry. The slow diagnostics + LLM auto-fix run
  // batched at agent_end over the same `touched` set.
  pi.on("tool_result", async (event) => {
    if (event.isError) return;

    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input);
    if (!p) return;
    const note = await processFile(toAbs(p, cwd));
    if (note)
      return { content: [...event.content, { type: "text", text: note }] };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (reported || touched.size === 0) return;
    if (isRebasing(ctx.cwd ?? cwd)) return;
    const files = Array.from(touched);
    touched.clear();
    reported = true;
    // Fire-and-forget: return immediately so pi marks the turn idle.
    // The widget appears when the background work finishes.
    void runFeedback(files, ctx, autoFix).catch((e) => {
      console.error(
        "[lsp-feedback] background run failed:",
        e instanceof Error ? e.message : String(e),
      );
    });
  });

  pi.registerCommand("lsp-fix", {
    description:
      "Toggle background LSP auto-fix for this session. `/lsp-fix` flips it; `/lsp-fix on|off` sets it explicitly.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        autoFix = arg === "on";
      } else if (arg === "") {
        autoFix = !autoFix;
      } else {
        ctx.ui.notify(`lsp-fix: unknown arg '${arg}' (use on/off)`, "warning");
        return;
      }
      ctx.ui.notify(`lsp-feedback auto-fix ${autoFix ? "on" : "off"}`, "info");
    },
  });
}
