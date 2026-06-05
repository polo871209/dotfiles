// worktree — agent-driven git worktrees for parallel/isolated development.
// Create a branch's worktree, see status across all worktrees, and merge a
// finished branch back into trunk (rebase + test-gate + fast-forward) with
// cleanup. Worktrees nest under ./.worktrees/<branch> in the current repo.
// Tools key off branch name and use absolute paths, so they work without a
// persistent shell directory. Registers only when the `wt` binary is present.

import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WT = "wt";
// Nest worktrees inside the repo instead of the sibling-dir default. Injected
// per-spawn so the harness stays self-contained (no global wt config needed).
const NEST_TEMPLATE = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}";

interface WtResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<WtResult> {
  return new Promise((resolve) => {
    const child = spawn(WT, args, {
      cwd,
      signal,
      // Force nested paths on every command so wt's path math stays
      // consistent (mismatch warnings + failed cleanup otherwise).
      env: { ...process.env, WORKTRUNK_WORKTREE_PATH: NEST_TEMPLATE },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    child.on("error", (e) =>
      resolve({ stdout, stderr: stderr + String(e), code: 1 }),
    );
  });
}

const relPath = (abs: string, cwd: string): string => {
  if (!abs) return abs;
  const rel = path.relative(cwd, abs);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? abs : rel;
};

const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { success: false },
});

interface WtEntry {
  branch: string | null;
  path?: string;
  kind: string;
  is_main?: boolean;
  is_current?: boolean;
  main_state?: string;
  main?: { ahead: number; behind: number };
  working_tree?: Record<string, unknown>;
}

// Resolve the absolute worktree path for a branch via `wt list` JSON.
async function pathForBranch(
  branch: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await run(["-C", cwd, "list", "--format=json"], cwd, signal);
  if (res.code !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as WtEntry[];
    const hit = entries.find((e) => e.branch === branch && e.path);
    return hit?.path ?? null;
  } catch {
    return null;
  }
}

const createTool = defineTool({
  name: "worktree_create",
  label: "Create Worktree",
  description:
    "Create an isolated worktree + branch off trunk and get back its absolute path. Use to start a new line of work without disturbing the main checkout; do file edits under the returned path. Reuses the worktree if the branch already has one.",
  promptSnippet: "Start an isolated worktree for a new branch",
  promptGuidelines: [
    "After this returns a path, do all Read/Edit/Bash for that work under the absolute worktree path — the agent has no persistent cwd.",
    "When the work is done and verified, finish with worktree_merge to land it on trunk.",
  ],
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create or reuse." }),
    base: Type.Optional(
      Type.String({
        description: "Base branch to fork from. Defaults to trunk.",
      }),
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const p = params as { branch: string; base?: string };
    const args = ["-C", ctx.cwd, "switch", "-c", p.branch];
    if (p.base) args.push("-b", p.base);
    args.push("--format=json", "--no-cd", "-y");
    const res = await run(args, ctx.cwd, signal);
    if (res.code !== 0)
      return fail(`worktree create failed:\n${res.stderr.trim()}`);
    try {
      const j = JSON.parse(res.stdout) as {
        action: string;
        branch: string | null;
        path: string;
      };
      const verb = j.action === "created" ? "Created" : "Reusing";
      return {
        content: [
          {
            type: "text" as const,
            text: `${verb} worktree for ${j.branch} at ${j.path}\nDo edits under this absolute path.`,
          },
        ],
        details: { success: true, action: j.action, path: j.path },
      };
    } catch {
      return fail(`unexpected wt output:\n${res.stdout}`);
    }
  },
});

const listTool = defineTool({
  name: "worktree_list",
  label: "List Worktrees",
  description:
    "Status across all worktrees: path, how each branch sits relative to trunk (ahead/behind, integrated, diverged), and whether it has uncommitted changes. Use to see what's in flight or decide what's safe to merge or remove.",
  promptSnippet: "See all worktrees and their state vs trunk",
  parameters: Type.Object({}),
  async execute(_id, _params, signal, _onUpdate, ctx) {
    const res = await run(
      ["-C", ctx.cwd, "list", "--format=json"],
      ctx.cwd,
      signal,
    );
    if (res.code !== 0)
      return fail(`worktree list failed:\n${res.stderr.trim()}`);
    let entries: WtEntry[];
    try {
      entries = JSON.parse(res.stdout) as WtEntry[];
    } catch {
      return fail(`unexpected wt output:\n${res.stdout}`);
    }
    if (entries.length === 0)
      return {
        content: [{ type: "text" as const, text: "No worktrees" }],
        details: { success: true, count: 0 },
      };
    const dirty = (wt?: Record<string, unknown>): boolean =>
      !!wt &&
      ["staged", "modified", "untracked", "renamed", "deleted"].some(
        (k) => !!wt[k],
      );
    const lines = entries.map((e) => {
      const tags: string[] = [];
      if (e.is_main) tags.push("main");
      if (e.is_current) tags.push("current");
      if (e.main_state && !e.is_main) tags.push(e.main_state);
      if (e.main && (e.main.ahead || e.main.behind))
        tags.push(`+${e.main.ahead}/-${e.main.behind}`);
      if (dirty(e.working_tree)) tags.push("dirty");
      const loc = e.path ? relPath(e.path, ctx.cwd) : "(no worktree)";
      return `  ${e.branch ?? "(detached)"}  ${loc}${tags.length ? `  [${tags.join(", ")}]` : ""}`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `${entries.length} worktree(s):\n${lines.join("\n")}`,
        },
      ],
      details: { success: true, count: entries.length },
    };
  },
});

const mergeTool = defineTool({
  name: "worktree_merge",
  label: "Merge Worktree",
  description:
    "Land a branch's worktree onto trunk: rebase onto trunk, run the project's pre-merge test gate, fast-forward merge, then remove the worktree and branch. Squashes to one commit by default. Aborts on rebase conflict or failing tests. Use when a branch's work is finished and verified.",
  promptSnippet: "Merge a finished worktree branch into trunk and clean up",
  promptGuidelines: [
    "Only merge after the work is verified — pre-merge hooks run as a local gate but tests should already pass.",
    "On conflict or hook failure the merge aborts and nothing lands; resolve, then retry.",
  ],
  parameters: Type.Object({
    branch: Type.String({ description: "Branch whose worktree to merge." }),
    noSquash: Type.Optional(
      Type.Boolean({ description: "Preserve individual commits (no squash)." }),
    ),
    noFf: Type.Optional(
      Type.Boolean({
        description: "Create a merge commit instead of fast-forward.",
      }),
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const p = params as { branch: string; noSquash?: boolean; noFf?: boolean };
    const wtPath = await pathForBranch(p.branch, ctx.cwd, signal);
    if (!wtPath) return fail(`no worktree found for branch ${p.branch}`);
    const args = ["-C", wtPath, "merge", "--format=json", "-y"];
    if (p.noSquash) args.push("--no-squash");
    if (p.noFf) args.push("--no-ff");
    const res = await run(args, ctx.cwd, signal);
    if (res.code !== 0)
      return fail(`merge aborted (nothing landed):\n${res.stderr.trim()}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Merged ${p.branch} into trunk; worktree removed.\n${res.stderr.trim()}`,
        },
      ],
      details: { success: true, branch: p.branch },
    };
  },
});

const removeTool = defineTool({
  name: "worktree_remove",
  label: "Remove Worktree",
  description:
    "Remove a branch's worktree and delete the branch. Refuses if the branch has unmerged commits or uncommitted changes unless force is set. Use to discard or clean up an abandoned line of work.",
  promptSnippet: "Remove a worktree and its branch",
  parameters: Type.Object({
    branch: Type.String({ description: "Branch whose worktree to remove." }),
    force: Type.Optional(
      Type.Boolean({
        description: "Remove even with uncommitted changes / unmerged commits.",
      }),
    ),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const p = params as { branch: string; force?: boolean };
    const args = ["-C", ctx.cwd, "remove", p.branch, "--format=json", "-y"];
    if (p.force) args.push("-f", "-D");
    const res = await run(args, ctx.cwd, signal);
    if (res.code !== 0) return fail(`remove failed:\n${res.stderr.trim()}`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Removed worktree + branch ${p.branch}`,
        },
      ],
      details: { success: true, branch: p.branch },
    };
  },
});

export default function (pi: ExtensionAPI) {
  // Skip registration when wt isn't installed (mise: ubi:max-sixty/worktrunk).
  const probe = spawnSync(WT, ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) return;
  pi.registerTool(createTool);
  pi.registerTool(listTool);
  pi.registerTool(mergeTool);
  pi.registerTool(removeTool);
}
