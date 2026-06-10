// worktree — agent-driven git worktrees for parallel/isolated development.
// Create a feature branch's worktree off the default branch, see status
// across all worktrees, and publish a finished branch to origin for a PR.
// Trunk is never merged into locally — PRs are the only landing path.
// Worktrees nest under ./.worktrees/<branch> in the current repo.
// Tools key off branch name and use absolute paths, so they work without a
// persistent shell directory. Registers only when the `wt` binary is present.

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
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

// Keep the nested .worktrees/ dir out of main's `git status` by adding it to
// the repo's local exclude (.git/info/exclude) — no tracked-file change.
function ensureWorktreesExcluded(cwd: string): void {
  const probe = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
    encoding: "utf-8",
  });
  if (probe.status !== 0) return;
  let dir = probe.stdout.trim();
  if (!dir) return;
  if (!path.isAbsolute(dir)) dir = path.resolve(cwd, dir);
  const exclude = path.join(dir, "info", "exclude");
  try {
    const cur = readFileSync(exclude, "utf-8");
    if (cur.split(/\r?\n/).some((l) => l.trim() === ".worktrees/")) return;
    appendFileSync(
      exclude,
      cur.endsWith("\n") ? ".worktrees/\n" : "\n.worktrees/\n",
    );
  } catch {
    try {
      appendFileSync(exclude, ".worktrees/\n");
    } catch {}
  }
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
    "Create an isolated worktree + feature branch off the default branch and get back its absolute path. Use to start a new line of work without disturbing the main checkout; do file edits under the returned path. Reuses the worktree if the branch already has one.",
  promptSnippet: "Start an isolated worktree for a new feature branch",
  promptGuidelines: [
    "After this returns a path, do all Read/Edit/Bash for that work under the absolute worktree path — the agent has no persistent cwd.",
    "When the work is done and verified, finish with worktree_publish so a PR can be opened. Never merge into the default branch locally.",
  ],
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create or reuse." }),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const p = params as { branch: string };
    ensureWorktreesExcluded(ctx.cwd);
    const args = ["-C", ctx.cwd, "switch", "-c", p.branch];
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

const publishTool = defineTool({
  name: "worktree_publish",
  label: "Publish Worktree",
  description:
    "Push a finished worktree branch to origin so a PR can be opened. Refuses if the worktree has uncommitted changes. Never merges into the default branch — PR review is the only landing path. Keep the worktree until the PR is merged, then worktree_remove.",
  promptSnippet: "Push a finished worktree branch to origin for a PR",
  promptGuidelines: [
    "Only publish after the work is committed and verified.",
    "PR creation and merging are the user's job unless explicitly asked.",
  ],
  parameters: Type.Object({
    branch: Type.String({ description: "Branch whose worktree to publish." }),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    const p = params as { branch: string };
    const wtPath = await pathForBranch(p.branch, ctx.cwd, signal);
    if (!wtPath) return fail(`no worktree found for branch ${p.branch}`);
    const status = spawnSync("git", ["-C", wtPath, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    if (status.status !== 0)
      return fail(`git status failed:\n${status.stderr}`);
    if (status.stdout.trim())
      return fail(
        `worktree has uncommitted changes — commit them first:\n${status.stdout.trim()}`,
      );
    const push = spawnSync(
      "git",
      ["-C", wtPath, "push", "-u", "origin", p.branch],
      { encoding: "utf-8" },
    );
    if (push.status !== 0) return fail(`push failed:\n${push.stderr.trim()}`);
    // GitHub prints a "Create a pull request" URL on stderr of a first push.
    return {
      content: [
        {
          type: "text" as const,
          text: `Pushed ${p.branch} to origin — ready for PR.\n${push.stderr.trim()}`,
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
  pi.registerTool(publishTool);
  pi.registerTool(removeTool);
}
