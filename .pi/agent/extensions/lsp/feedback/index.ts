// Inline formatting keeps edit results synchronized with disk. At
// agent_before_settle, one deterministic batched pass applies safe LSP actions
// and reads Neovim's aggregate diagnostics. Survivors go back to the same main
// agent as a bounded repair turn inside the same run, so agent_settled fires
// only once the repair is done.
//
// registerFeedback(pi) is called from lsp/index.ts — this is part of the lsp
// extension (shares its nvim), not a standalone one.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { displayPath, formatDiagLine, sortDiagnostics, toAbs } from "../utils";
import {
  ensureFeedbackLoaded,
  formatFile,
  MAX_FILE_BYTES,
  runDriver,
} from "./driver";
import { changeNote } from "./diff";

const MAX_REPAIR_FOLLOWUPS = 2;
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
  // Files edited since the last clean pass. Kept across repair turns so each
  // agent_before_settle re-checks the whole task, not only the last fix.
  const touched = new Set<string>();
  let repairFollowups = 0;
  let cwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    touched.clear();
    repairFollowups = 0;
    // Warm nvim + feedback lua in the background so the first edit skips spawn
    // + init.lua + LSP-attach. Deferred a tick to keep the sync prefix (file
    // read + spawn syscall) off pi's startup path.
    setTimeout(() => {
      void ensureFeedbackLoaded(cwd).catch(() => {});
      // Warm the inline lane too: format-on-edit runs on its own nvim so it
      // never queues behind the heavy turn-end pass on the main lane.
      void ensureFeedbackLoaded(cwd, "inline").catch(() => {});
    }, 0);
  });

  // Repair turns run inside the same agent run, so this fires only for a new
  // user prompt.
  pi.on("before_agent_start", async () => {
    touched.clear();
    repairFollowups = 0;
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
  // without a separate context entry. Deterministic diagnostics and safe LSP
  // actions run batched at agent_before_settle over the same `touched` set.
  pi.on("tool_result", async (event) => {
    if (event.isError) return;

    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input);
    if (!p) return;
    const note = await processFile(toAbs(p, cwd));
    if (note)
      return { content: [...event.content, { type: "text", text: note }] };
  });

  // Awaited by pi before it settles. After an abort or error, `touched` stays
  // so the next completed run checks those files too.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return;
    if (touched.size === 0 || repairFollowups >= MAX_REPAIR_FOLLOWUPS) return;
    const projectCwd = ctx.cwd ?? cwd;
    if (isRebasing(projectCwd)) return;
    const result = await runDriver(Array.from(touched), projectCwd, ctx.signal);
    if (!result) return;
    if (result.diagnostics.length === 0) {
      touched.clear();
      return;
    }
    repairFollowups++;
    const diagnostics = sortDiagnostics(result.diagnostics)
      .map((d) => formatDiagLine(d, projectCwd))
      .join("\n");
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: "lsp-feedback-diagnostics",
          content:
            "Deterministic LSP feedback still reports diagnostics across the files touched in this task. Fix them, then finish the task. Do not delegate this repair.\n" +
            diagnostics,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
