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
  const touched = new Set<string>();
  let allEditsChecked = true;
  let repairFollowups = 0;
  let consecutiveMissedPasses = 0;

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    touched.clear();
    allEditsChecked = true;
    repairFollowups = 0;
    consecutiveMissedPasses = 0;
    setTimeout(() => {
      void ensureFeedbackLoaded(cwd).catch(() => {});
      void ensureFeedbackLoaded(cwd, "inline").catch(() => {});
    }, 0);
  });

  pi.on("before_agent_start", async () => {
    if (allEditsChecked) touched.clear();
    repairFollowups = 0;
  });

  const processFile = async (
    abs: string,
    cwd: string,
  ): Promise<string | undefined> => {
    if (!fs.existsSync(abs)) return;
    if (isScratchPath(abs)) return;
    if (isIgnoredPath(abs, cwd)) return;
    touched.add(abs);
    allEditsChecked = false;
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

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const p = extractPath(event.input);
    if (!p) return;
    const note = await processFile(toAbs(p, ctx.cwd), ctx.cwd);
    if (note)
      return { content: [...event.content, { type: "text", text: note }] };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return;
    if (touched.size === 0 || repairFollowups >= MAX_REPAIR_FOLLOWUPS) return;
    const projectCwd = ctx.cwd;
    if (isRebasing(projectCwd)) return;
    const result = await runDriver(Array.from(touched), projectCwd, ctx.signal);
    if (!result) {
      if (++consecutiveMissedPasses >= 2) {
        allEditsChecked = true;
        consecutiveMissedPasses = 0;
      }
      return;
    }
    consecutiveMissedPasses = 0;
    allEditsChecked = true;
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
