// Inline formatting keeps edit results synchronized with disk. At
// agent_before_settle, one deterministic batched pass applies safe LSP actions
// and reads Neovim's aggregate diagnostics. Survivors go back to the same main
// agent as a bounded repair turn inside the same run, so agent_settled fires
// only once the repair is done.
//
// registerFeedback(pi) is called from lsp/index.ts — this is part of the lsp
// extension (shares its nvim), not a standalone one.
import {
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
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
const TRACKED_TOOLS = new Set(["edit", "write"]);

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

// Skip throwaway scratch paths, including macOS $TMPDIR under /var/folders.
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
  // False once an edit lands, true once a diagnostics pass covers it. pi skips
  // agent_before_settle after an abort, so unchecked edits must carry over.
  let checked = true;
  let repairFollowups = 0;
  // Passes in a row that returned no result. A broken daemon costs up to
  // MAX_PASS_MS per try, so the edits count as checked after the second miss.
  let missedPasses = 0;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    touched.clear();
    checked = true;
    repairFollowups = 0;
    missedPasses = 0;
    // Warm nvim and the feedback lua in the background so the first edit skips
    // spawn, init.lua, and LSP attach. Deferred a tick to keep the sync prefix
    // (file read + spawn syscall) off pi's startup path.
    setTimeout(() => {
      void ensureFeedbackLoaded(cwd).catch(() => {});
      // Warm the inline lane too: format-on-edit runs on its own nvim so it
      // never queues behind the heavy turn-end pass on the main lane.
      void ensureFeedbackLoaded(cwd, "inline").catch(() => {});
    }, 0);
  });

  // Repair turns run inside the same agent run, so this fires only for a new
  // user prompt. Files already checked are dropped, so diagnostics the agent
  // could not fix do not nag every later prompt.
  pi.on("before_agent_start", async () => {
    if (checked) touched.clear();
    repairFollowups = 0;
  });

  // Format one file in place, register it for the batched diagnostics pass, and
  // return a format-delta note (undefined if skipped or unchanged). The queue
  // is pi's per-file lock for edit and write, so a parallel edit cannot land
  // between our read, format, and re-read.
  const processFile = async (
    abs: string,
    cwd: string,
  ): Promise<string | undefined> => {
    if (!fs.existsSync(abs)) return;
    if (isScratchPath(abs)) return;
    if (isIgnoredPath(abs, cwd)) return;
    touched.add(abs);
    checked = false;
    return withFileMutationQueue(abs, async () => {
      try {
        const before = fs.readFileSync(abs, "utf8");
        if (Buffer.byteLength(before) > MAX_FILE_BYTES) return;
        if (!(await formatFile(abs, cwd))) return;
        const after = fs.readFileSync(abs, "utf8");
        if (after === before) return;
        return changeNote(
          before,
          after,
          displayPath(abs, cwd),
          "auto-formatted",
        );
      } catch {
        return;
      }
    });
  };

  // Fold each file's format delta into the tool result so the agent stays
  // synced to disk without a re-read. Diagnostics and code actions run batched
  // at agent_before_settle over the same `touched` set.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input);
    if (!p) return;
    const note = await processFile(toAbs(p, ctx.cwd), ctx.cwd);
    if (note)
      return { content: [...event.content, { type: "text", text: note }] };
  });

  // Awaited by pi before it settles. After an abort or error, `touched` stays
  // so the next completed run checks those files too. ctx.signal is undefined
  // here (no agent run is active), so runDriver's own cap bounds the wait.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return;
    if (touched.size === 0 || repairFollowups >= MAX_REPAIR_FOLLOWUPS) return;
    const projectCwd = ctx.cwd;
    if (isRebasing(projectCwd)) return;
    const result = await runDriver(Array.from(touched), projectCwd, ctx.signal);
    // No result means no pass ran, so the edits stay unchecked for one retry.
    if (!result) {
      if (++missedPasses >= 2) {
        checked = true;
        missedPasses = 0;
      }
      return;
    }
    missedPasses = 0;
    checked = true;
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
