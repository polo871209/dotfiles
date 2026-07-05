// worktree — agent-driven git worktrees for parallel/isolated development,
// backed by herdr's own worktree feature. Each worktree lives in its own
// herdr workspace with a real `pi` agent pane, so the calling agent can hand
// off work and drive it directly (herdr pane run/read/wait) instead of
// switching cwd itself. Trunk is never merged into locally — PRs are the
// only landing path. Worktrees nest under ./.worktrees/<branch> in the repo.
// Herdr-only: registers only inside a live herdr pane.

import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WORKTREES_DIRNAME = ".worktrees";
const execFileAsync = promisify(execFile);

function herdrActive(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_WORKSPACE_ID;
}

// Scope every herdr worktree call to the calling agent's own workspace
// instead of `--cwd`, which auto-opens a whole extra "source" workspace as a
// side effect when the path hasn't been seen by herdr before.
function workspaceArgs(): string[] {
  return ["--workspace", process.env.HERDR_WORKSPACE_ID!];
}

async function herdrJson<T>(
  args: string[],
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync("herdr", args, { timeout: 15_000 });
    const parsed = JSON.parse(stdout) as { result: T };
    return { ok: true, value: parsed.result };
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    if (stdout) {
      try {
        const j = JSON.parse(stdout) as { error?: { message?: string } };
        if (j.error?.message) return { ok: false, error: j.error.message };
      } catch {}
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout.trim(), err: stderr.trim() });
    });
  });
}

async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, "rev-parse", "--show-toplevel");
  return r.ok ? r.out : null;
}

// A worktree is a fresh path to mise, so the pi agent that herdr spawns in
// it would otherwise block on an interactive "trust this config?" prompt
// before accepting any input. Trust it ourselves first — it's the same repo
// the user already trusts, just checked out elsewhere.
async function trustWorktree(wtPath: string): Promise<void> {
  await execFileAsync("mise", ["trust", "--yes", wtPath]).catch(() => {});
}

// No hardcoded "main" — ask git for the real default branch.
async function resolveDefaultBranch(cwd: string): Promise<string | null> {
  const symref = await git(
    cwd,
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (symref.ok && symref.out) return symref.out;
  const remote = await git(cwd, "ls-remote", "--symref", "origin", "HEAD");
  const m = remote.out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  if (m) return `origin/${m[1]}`;
  for (const cand of ["main", "master"]) {
    if ((await git(cwd, "rev-parse", "--verify", `refs/heads/${cand}`)).ok)
      return cand;
  }
  return null;
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
    if (cur.split(/\r?\n/).some((l) => l.trim() === `${WORKTREES_DIRNAME}/`))
      return;
    appendFileSync(
      exclude,
      cur.endsWith("\n")
        ? `${WORKTREES_DIRNAME}/\n`
        : `\n${WORKTREES_DIRNAME}/\n`,
    );
  } catch {
    try {
      appendFileSync(exclude, `${WORKTREES_DIRNAME}/\n`);
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
  error: text,
});

const worktreePath = (root: string, branch: string): string =>
  path.join(root, WORKTREES_DIRNAME, branch.replace(/[\\/]+/g, "-"));

interface HerdrWorktreeEntry {
  branch: string | null;
  path: string;
  is_linked_worktree: boolean;
  is_prunable?: boolean;
  open_workspace_id?: string;
}

interface HerdrWorktreeListResult {
  worktrees: HerdrWorktreeEntry[];
}

async function listWorktrees(): Promise<
  { ok: true; entries: HerdrWorktreeEntry[] } | { ok: false; error: string }
> {
  const res = await herdrJson<HerdrWorktreeListResult>([
    "worktree",
    "list",
    ...workspaceArgs(),
  ]);
  if (!res.ok) return res;
  return { ok: true, entries: res.value.worktrees };
}

const createTool = defineTool({
  name: "worktree_create",
  label: "Create Worktree",
  description:
    "Create an isolated worktree + feature branch off the default branch, opened as its own herdr workspace with a live agent pane. Use to start a new line of work without disturbing the main checkout. Reuses the worktree if the branch already has one.",
  promptSnippet: "Start an isolated worktree for a new feature branch",
  promptGuidelines: [
    'The returned pane is a live, idle pi agent already rooted in the worktree — hand off work to it directly with `herdr pane run <pane_id> "<task>"`, watch it with `herdr pane read`/`herdr wait agent-status`, and read its result back.',
    "When the work is done and verified, finish with worktree_publish so a PR can be opened. Never merge into the default branch locally.",
  ],
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create or reuse." }),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const p = params as { branch: string };
    const root = await repoRoot(ctx.cwd);
    if (!root) return fail("not a git repository");
    ensureWorktreesExcluded(root);
    const wtPath = worktreePath(root, p.branch);

    let verb: string;
    if (!existsSync(wtPath)) {
      const hasBranch = (
        await git(root, "rev-parse", "--verify", `refs/heads/${p.branch}`)
      ).ok;
      const add = hasBranch
        ? await git(root, "worktree", "add", wtPath, p.branch)
        : await (async () => {
            const base = await resolveDefaultBranch(root);
            if (!base) return null;
            return git(root, "worktree", "add", "-b", p.branch, wtPath, base);
          })();
      if (!add) return fail("cannot determine default branch");
      if (!add.ok) return fail(`worktree create failed:\n${add.err}`);
      await trustWorktree(wtPath);
      verb = "Created";
    } else {
      verb = "Reusing";
    }

    const res = await herdrJson<{
      already_open?: boolean;
      root_pane: { pane_id: string; workspace_id: string };
      workspace: { workspace_id: string };
      worktree: { path: string; branch: string | null };
    }>([
      "worktree",
      "open",
      ...workspaceArgs(),
      "--path",
      wtPath,
      "--no-focus",
    ]);
    if (!res.ok) return fail(`worktree open failed:\n${res.error}`);
    if (verb === "Reusing")
      verb = res.value.already_open ? "Already open" : "Reopened";
    const { root_pane, worktree } = res.value;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${verb} worktree for ${worktree.branch} at ${worktree.path}\n` +
            `Agent pane: ${root_pane.pane_id} — drive it with herdr pane run/read/wait, don't edit here directly.`,
        },
      ],
      details: {
        success: true,
        path: worktree.path,
        paneId: root_pane.pane_id,
        workspaceId: root_pane.workspace_id,
      },
    };
  },
});

const listTool = defineTool({
  name: "worktree_list",
  label: "List Worktrees",
  description:
    "Status across all worktrees: path, whether it's open as a herdr workspace, how each branch sits relative to trunk (ahead/behind, dirty). Use to see what's in flight or decide what's safe to remove.",
  promptSnippet: "See all worktrees and their state vs trunk",
  parameters: Type.Object({}),
  async execute(_id, _params, _signal, _onUpdate, ctx) {
    const listed = await listWorktrees();
    if (!listed.ok) return fail(`worktree list failed:\n${listed.error}`);
    const { entries } = listed;
    if (entries.length === 0)
      return {
        content: [{ type: "text" as const, text: "No worktrees" }],
        details: { success: true, count: 0 },
      };
    const def = await resolveDefaultBranch(ctx.cwd);
    const lines = await Promise.all(
      entries.map(async (e) => {
        const tags: string[] = [];
        if (!e.is_linked_worktree) tags.push("main");
        if (e.open_workspace_id) tags.push("open");
        if (e.is_linked_worktree && def && e.branch) {
          const counts = await git(
            e.path,
            "rev-list",
            "--left-right",
            "--count",
            `${def}...HEAD`,
          );
          const [behind, ahead] = counts.ok
            ? counts.out.split(/\s+/)
            : ["0", "0"];
          if (Number(ahead) || Number(behind))
            tags.push(`+${ahead}/-${behind}`);
        }
        const status = await git(e.path, "status", "--porcelain");
        if (status.ok && status.out) tags.push("dirty");
        const loc = relPath(e.path, ctx.cwd);
        return `  ${e.branch ?? "(detached)"}  ${loc}${tags.length ? `  [${tags.join(", ")}]` : ""}`;
      }),
    );
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
  async execute(_id, params, _signal, _onUpdate, _ctx) {
    const p = params as { branch: string };
    const listed = await listWorktrees();
    if (!listed.ok) return fail(`worktree list failed:\n${listed.error}`);
    const entry = listed.entries.find((e) => e.branch === p.branch);
    if (!entry) return fail(`no worktree found for branch ${p.branch}`);
    const status = await git(entry.path, "status", "--porcelain");
    if (!status.ok) return fail(`git status failed:\n${status.err}`);
    if (status.out)
      return fail(
        `worktree has uncommitted changes — commit them first:\n${status.out}`,
      );
    const push = await git(entry.path, "push", "-u", "origin", p.branch);
    if (!push.ok) return fail(`push failed:\n${push.err}`);
    // GitHub prints a "Create a pull request" URL on stderr of a first push.
    return {
      content: [
        {
          type: "text" as const,
          text: `Pushed ${p.branch} to origin — ready for PR.\n${push.err}`,
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
    "Remove a branch's worktree (closing its herdr workspace) and delete the branch. Refuses if the branch has unmerged commits or uncommitted changes unless force is set. Use to discard or clean up an abandoned line of work.",
  promptSnippet: "Remove a worktree and its branch",
  parameters: Type.Object({
    branch: Type.String({ description: "Branch whose worktree to remove." }),
    force: Type.Optional(
      Type.Boolean({
        description: "Remove even with uncommitted changes / unmerged commits.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const p = params as { branch: string; force?: boolean };
    const root = await repoRoot(ctx.cwd);
    if (!root) return fail("not a git repository");
    const listed = await listWorktrees();
    if (!listed.ok) return fail(`worktree list failed:\n${listed.error}`);
    const entry = listed.entries.find((e) => e.branch === p.branch);
    if (!entry) return fail(`no worktree found for branch ${p.branch}`);

    let workspaceId = entry.open_workspace_id;
    if (!workspaceId) {
      await trustWorktree(entry.path);
      const opened = await herdrJson<{ workspace: { workspace_id: string } }>([
        "worktree",
        "open",
        ...workspaceArgs(),
        "--path",
        entry.path,
        "--no-focus",
      ]);
      if (!opened.ok) return fail(`worktree remove failed:\n${opened.error}`);
      workspaceId = opened.value.workspace.workspace_id;
    }
    const removeArgs = ["worktree", "remove", "--workspace", workspaceId];
    if (p.force) removeArgs.push("--force");
    const removed = await herdrJson(removeArgs);
    if (!removed.ok) return fail(`worktree remove failed:\n${removed.error}`);

    const del = await git(root, "branch", p.force ? "-D" : "-d", p.branch);
    if (!del.ok)
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Removed worktree for ${p.branch}, but branch still exists ` +
              `(${del.err}) — rerun with force to delete it too.`,
          },
        ],
        details: { success: true, branch: p.branch, branchDeleted: false },
      };
    return {
      content: [
        {
          type: "text" as const,
          text: `Removed worktree + branch ${p.branch}`,
        },
      ],
      details: { success: true, branch: p.branch, branchDeleted: true },
    };
  },
});

export default function (pi: ExtensionAPI) {
  if (!herdrActive()) return;
  pi.registerTool(createTool);
  pi.registerTool(listTool);
  pi.registerTool(publishTool);
  pi.registerTool(removeTool);
}
