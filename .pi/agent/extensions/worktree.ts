import {
  copyFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "./shared/exec";
import { errorMessage } from "./shared/error";

const BARE_DIR = ".bare";
const TOOL_NAME = "worktree";
const LOCAL_CONFIG = /^(\.env(\.[^/]+)?|\.?mise(\.[^/]+)?\.toml)$/;

interface Worktree {
  path: string;
  branch?: string;
}

interface Repo {
  root: string;
  defaultBranch: string;
  worktrees: Worktree[];
}

interface CreatedWorktree extends Worktree {
  branch: string;
  created: boolean;
  copied: string[];
}

interface PendingMove {
  commandArgs: string;
  continuation: string;
}

interface LinkedWorktree {
  root: string;
  home: string;
  path: string;
  branch?: string;
}

type WorktreeInfo = {
  branch: string | null;
  path: string;
  home: boolean;
  changes: number | null;
  ahead: number | null;
  behind: number | null;
  tab: string | null;
};

type ToolData = {
  worktrees?: WorktreeInfo[];
  path?: string;
  branch?: string;
  window_id?: string;
  block_id?: string;
};

interface RexWindow {
  window_id: string;
  label: string;
  layers: { blocks: { block_id: string }[] }[];
}

interface Tab {
  window_id: string;
  block_id: string;
}

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const r = await run("git", args, signal, cwd, 60_000);
  if (r.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

function bareRoot(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;
  for (let dir = realpathSync(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, BARE_DIR))) return dir;
    if (dir === dirname(dir)) return undefined;
  }
}

async function listWorktrees(
  root: string,
  signal?: AbortSignal,
): Promise<Worktree[]> {
  const out = await git(root, ["worktree", "list", "--porcelain"], signal);
  return out
    .split("\n\n")
    .map((block) => block.split("\n"))
    .filter((lines) => !lines.includes("bare"))
    .map((lines) => {
      const path = lines.find((l) => l.startsWith("worktree "))!.slice(9);
      const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
      return { path, branch: ref?.replace(/^refs\/heads\//, "") };
    });
}

async function openRepo(cwd: string, signal?: AbortSignal): Promise<Repo> {
  const root = bareRoot(cwd);
  if (!root)
    throw new Error(
      `${cwd} is not in a repo with one folder per branch. Clone the repo with \`clone <url>\` first.`,
    );
  const head = await git(
    root,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    signal,
  ).catch(() => {
    throw new Error(
      `origin/HEAD is not set. Run \`git remote set-head origin --auto\` in ${root}.`,
    );
  });
  return {
    root,
    defaultBranch: head.replace(/^origin\//, ""),
    worktrees: await listWorktrees(root, signal),
  };
}

const homeOf = (repo: Repo) =>
  repo.worktrees.find((w) => w.branch === repo.defaultBranch);

async function copyLocalConfig(
  from: string,
  to: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const ignored = await git(
    from,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    signal,
  );
  const files = ignored.split("\n").filter((f) => LOCAL_CONFIG.test(f));
  for (const file of files) copyFileSync(join(from, file), join(to, file));
  return files;
}

async function ensureWorktree(
  repo: Repo,
  branch: string,
  base?: string,
  signal?: AbortSignal,
): Promise<CreatedWorktree> {
  const { root } = repo;
  await git(root, ["check-ref-format", "--branch", branch], signal);
  const existing = repo.worktrees.find((w) => w.branch === branch);
  if (existing)
    return { path: existing.path, branch, created: false, copied: [] };

  const path = join(root, branch);
  const hasLocal =
    (
      await run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
        root,
      )
    ).code === 0;
  const remotes = hasLocal
    ? []
    : (
        await git(
          root,
          [
            "for-each-ref",
            "--format=%(refname:short)",
            `refs/remotes/*/${branch}`,
          ],
          signal,
        )
      )
        .split("\n")
        .filter(Boolean);
  const remote = remotes.find((r) => r === `origin/${branch}`) ?? remotes[0];
  const args = hasLocal
    ? ["worktree", "add", path, branch]
    : remote
      ? ["worktree", "add", "--track", "-b", branch, path, remote]
      : ["worktree", "add", "-b", branch, path, base ?? repo.defaultBranch];
  await git(root, args, signal);
  const home = homeOf(repo);
  const copied = home ? await copyLocalConfig(home.path, path, signal) : [];
  return { path, branch, created: true, copied };
}

async function currentWorktree(
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const r = await run("git", ["rev-parse", "--show-toplevel"], signal, cwd);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function finishableWorktree(
  cwd: string,
  signal?: AbortSignal,
): Promise<LinkedWorktree> {
  const repo = await openRepo(cwd, signal);
  const path = await currentWorktree(cwd, signal);
  if (!path)
    throw new Error(`This session is in ${cwd}, which is not a branch folder.`);
  const branch = repo.worktrees.find((w) => w.path === path)?.branch;
  if (branch === repo.defaultBranch)
    throw new Error(
      `This session is in the worktree of the default branch ${repo.defaultBranch}, which stays.`,
    );
  const home = await ensureWorktree(
    repo,
    repo.defaultBranch,
    undefined,
    signal,
  );
  return { root: repo.root, home: home.path, path, branch };
}

async function removeFolder(
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(root, ["worktree", "remove", "--force", path], signal);
  for (
    let dir = dirname(path);
    dir.startsWith(`${root}/`) && !readdirSync(dir).length;
    dir = dirname(dir)
  )
    rmdirSync(dir);
}

async function deleteBranch(
  root: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const sha = await git(
    root,
    ["rev-parse", "--short", `refs/heads/${branch}`],
    signal,
  );
  await git(root, ["branch", "-D", branch], signal);
  return `Deleted branch ${branch} at ${sha}. Restore it with \`git branch ${branch} ${sha}\`.`;
}

async function removeLinked(
  { root, path, branch }: LinkedWorktree,
  signal?: AbortSignal,
): Promise<string> {
  await removeFolder(root, path, signal);
  const removed = `Removed ${path}.`;
  return branch
    ? `${removed} ${await deleteBranch(root, branch, signal)}`
    : removed;
}

async function removeBranch(
  repo: Repo,
  branch: string,
  here: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (branch === repo.defaultBranch)
    throw new Error(`Branch ${branch} is the default branch, and it stays.`);
  const worktree = repo.worktrees.find((w) => w.branch === branch);
  if (worktree?.path === here)
    throw new Error(
      "This session is in that branch's folder. Use `done` without a branch.",
    );
  if (worktree) await removeFolder(repo.root, worktree.path, signal);
  else if (
    (
      await run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
        repo.root,
      )
    ).code !== 0
  )
    throw new Error(`No folder or local branch is named ${branch}.`);
  const deleted = await deleteBranch(repo.root, branch, signal);
  return worktree ? `Removed ${worktree.path}. ${deleted}` : deleted;
}

async function closeTab(branch: string, signal?: AbortSignal): Promise<string> {
  const session = process.env.REX_SESSION;
  if (!session) return "";
  try {
    const tab = tabOf(await rexWindows(session, signal), branch);
    if (!tab) return "";
    await rex(["window", "close", "-s", session, tab.window_id], signal);
    return " Closed its Rex tab.";
  } catch {
    return " Could not close its Rex tab.";
  }
}

async function rex(args: string[], signal?: AbortSignal): Promise<string> {
  const r = await run("rex", args, signal, undefined, 15_000);
  if (r.code !== 0)
    throw new Error(
      `rex ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}`,
    );
  return r.stdout;
}

async function rexWindows(
  session: string,
  signal?: AbortSignal,
): Promise<RexWindow[]> {
  const out = await rex(["window", "ls", "--json", "-s", session], signal);
  return (JSON.parse(out) as { windows: RexWindow[] }).windows;
}

const tabOf = (windows: RexWindow[], branch: string) =>
  windows.find((w) => w.label === branch);

const firstBlock = (window: RexWindow) =>
  window.layers[0]?.blocks[0]?.block_id ?? "";

async function openTab(
  session: string,
  branch: string,
  cwd: string,
  command: string[],
  signal?: AbortSignal,
): Promise<Tab> {
  const out = await rex(
    [
      "window",
      "new",
      "-s",
      session,
      branch,
      "-c",
      cwd,
      "--focus=false",
      "--json",
      "--",
      ...command,
    ],
    signal,
  );
  const created = JSON.parse(out) as { window_id: string; block_ids: string[] };
  return { window_id: created.window_id, block_id: created.block_ids[0]! };
}

async function clearTabLabel(branch: string): Promise<void> {
  const { REX_SESSION, REX_BLOCK } = process.env;
  if (!REX_SESSION || !REX_BLOCK) return;
  const window = (await rexWindows(REX_SESSION)).find((w) =>
    w.layers.some((l) => l.blocks.some((b) => b.block_id === REX_BLOCK)),
  );
  if (window?.label === branch)
    await rex(["window", "rename", "-s", REX_SESSION, window.window_id, ""]);
}

async function describeWorktrees(
  repo: Repo,
  signal?: AbortSignal,
): Promise<WorktreeInfo[]> {
  const session = process.env.REX_SESSION;
  const windows = session
    ? await rexWindows(session, signal).catch(() => [])
    : [];
  return Promise.all(
    repo.worktrees.map(async (w) => {
      const status = await run(
        "git",
        ["status", "--porcelain"],
        signal,
        w.path,
      );
      const counts = w.branch
        ? await run(
            "git",
            [
              "rev-list",
              "--left-right",
              "--count",
              `origin/${repo.defaultBranch}...${w.branch}`,
            ],
            signal,
            repo.root,
          )
        : undefined;
      const [behind, ahead] =
        counts?.code === 0
          ? counts.stdout.trim().split(/\s+/).map(Number)
          : [null, null];
      const tab = w.branch ? tabOf(windows, w.branch) : undefined;
      return {
        branch: w.branch ?? null,
        path: w.path,
        home: w.branch === repo.defaultBranch,
        changes:
          status.code === 0
            ? status.stdout.split("\n").filter(Boolean).length
            : null,
        ahead: ahead ?? null,
        behind: behind ?? null,
        tab: tab?.window_id ?? null,
      };
    }),
  );
}

function folderNote(
  root: string,
  w: { path: string; branch?: string | null },
): string | undefined {
  const folder = relative(root, w.path);
  return folder === w.branch ? undefined : `(folder ${folder}/)`;
}

function formatWorktrees(root: string, worktrees: WorktreeInfo[]): string {
  return worktrees
    .map((w) =>
      [
        w.branch ?? "(detached)",
        folderNote(root, w),
        w.home ? "default branch" : undefined,
        w.changes === null ? "missing" : `${w.changes} changed`,
        w.ahead === null ? undefined : `+${w.ahead} -${w.behind}`,
        w.tab ? "Rex tab open" : undefined,
      ]
        .filter(Boolean)
        .join("  "),
    )
    .join("\n");
}

function writeEmptySession(cwd: string): string {
  const session = SessionManager.create(cwd);
  const file = session.getSessionFile();
  if (!file) throw new Error("pi created no session file");
  writeFileSync(file, `${JSON.stringify(session.getHeader())}\n`, {
    flag: "wx",
  });
  return file;
}

function forkSession(ctx: ExtensionCommandContext, target: string): string {
  const source = ctx.sessionManager.getSessionFile();
  if (!source)
    throw new Error("This session is not saved to disk, so it cannot move.");
  const sessionFile = existsSync(source)
    ? SessionManager.forkFrom(source, target).getSessionFile()
    : writeEmptySession(target);
  if (!sessionFile) throw new Error("pi created no session file");
  return sessionFile;
}

async function switchToSession(
  ctx: ExtensionCommandContext,
  sessionFile: string,
  notice: string,
  continuation?: string,
): Promise<void> {
  await ctx.switchSession(sessionFile, {
    withSession: async (next) => {
      next.ui.notify(notice, "info");
      if (continuation)
        await next.sendMessage(
          { customType: "worktree", content: continuation, display: true },
          { triggerTurn: true },
        );
    },
  });
}

async function finishWorktree(
  ctx: ExtensionCommandContext,
  continuation?: string,
): Promise<void> {
  await ctx.waitForIdle();
  const linked = await finishableWorktree(ctx.cwd);
  const sessionFile = forkSession(ctx, linked.home);
  const removed = await removeLinked(linked);
  if (linked.branch) await clearTabLabel(linked.branch).catch(() => {});
  await switchToSession(
    ctx,
    sessionFile,
    `${removed} Session moved to ${linked.home}`,
    continuation,
  );
}

async function pickWorktree(
  ctx: ExtensionCommandContext,
): Promise<Worktree | undefined> {
  const { root, worktrees } = await openRepo(ctx.cwd);
  const here = await currentWorktree(ctx.cwd);
  const choices = new Map(
    worktrees.map((w) => [
      [
        w.path === here ? "●" : " ",
        w.branch ?? "(detached)",
        folderNote(root, w),
      ]
        .filter(Boolean)
        .join(" "),
      w,
    ]),
  );
  const label = await ctx.ui.select("Move session to worktree", [
    ...choices.keys(),
  ]);
  return label === undefined ? undefined : choices.get(label);
}

const reply = (
  text: string,
  structuredContent: ToolData,
  terminate = false,
) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  structuredContent,
  terminate,
});

function createdText(wt: CreatedWorktree): string {
  if (!wt.created) return `Found worktree ${wt.path} on branch ${wt.branch}.`;
  const copied = wt.copied.length
    ? ` Copied ${wt.copied.join(", ")} from the default-branch worktree.`
    : "";
  return `Created worktree ${wt.path} on branch ${wt.branch}.${copied}`;
}

export default function (pi: ExtensionAPI) {
  const { PI_CWD_FILE, PI_CWD_SHELL } = process.env;
  const shellCwdFile =
    PI_CWD_FILE && Number(PI_CWD_SHELL) === process.ppid
      ? PI_CWD_FILE
      : undefined;
  let pendingMove: PendingMove | undefined;

  const offerTool = (offered: boolean) => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME) === offered) return;
    pi.setActiveTools(
      offered
        ? [...active, TOOL_NAME]
        : active.filter((name) => name !== TOOL_NAME),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    // Pi keeps its launch directory when a session moves, and Rex reads the process directory for new panes.
    if (existsSync(ctx.cwd)) process.chdir(ctx.cwd);
    if (shellCwdFile) writeFileSync(shellCwdFile, ctx.cwd);
    offerTool(bareRoot(ctx.cwd) !== undefined);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!pendingMove) return;
    if (event.aborted) {
      ctx.ui.notify(
        `Worktree move cancelled. Run /wt ${pendingMove.commandArgs} to move.`,
        "warning",
      );
      pendingMove = undefined;
      return;
    }
    pi.sendUserMessage(`/wt ${pendingMove.commandArgs}`, {
      expandPromptTemplates: true,
    });
  });

  pi.registerCommand("wt", {
    description:
      "Move this session to a branch's worktree, or /wt done [branch] to delete a branch and its folder",
    getArgumentCompletions: async (prefix) => {
      const r = await run(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        undefined,
        process.cwd(),
        5_000,
      );
      if (r.code !== 0) return null;
      const done = {
        value: "done",
        label: "done",
        description:
          "Delete this folder and its branch, discarding changes, and move back to the default branch",
      };
      return fuzzyFilter(
        [
          done,
          ...r.stdout
            .split("\n")
            .filter(Boolean)
            .map((b) => ({ value: b, label: b })),
        ],
        prefix,
        (item) => item.value,
      );
    },
    handler: async (args, ctx) => {
      const commandArgs = args.trim();
      const continuation =
        pendingMove?.commandArgs === commandArgs
          ? pendingMove.continuation
          : undefined;
      pendingMove = undefined;
      if (!commandArgs && !ctx.hasUI) {
        ctx.ui.notify("Usage: /wt <branch> or /wt done", "error");
        return;
      }
      try {
        if (commandArgs === "done") {
          await finishWorktree(ctx, continuation);
          return;
        }
        const doneBranch = commandArgs.match(/^done\s+(\S+)$/)?.[1];
        if (doneBranch) {
          const removed = await removeBranch(
            await openRepo(ctx.cwd),
            doneBranch,
            await currentWorktree(ctx.cwd),
          );
          ctx.ui.notify(`${removed}${await closeTab(doneBranch)}`, "info");
          return;
        }
        const target = commandArgs
          ? await ensureWorktree(await openRepo(ctx.cwd), commandArgs)
          : await pickWorktree(ctx);
        if (!target) return;
        if (target.path === (await currentWorktree(ctx.cwd))) {
          ctx.ui.notify(`Session is already in ${target.path}`, "info");
          return;
        }
        await ctx.waitForIdle();
        await switchToSession(
          ctx,
          forkSession(ctx, target.path),
          `Session moved to ${target.path}`,
          continuation,
        );
      } catch (e) {
        ctx.ui.notify(errorMessage(e), "error");
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Worktree",
    defaultActive: false,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description:
      "One folder per branch in this repo. Use only when the user, AGENTS.md, or a plan asks, instead of `git worktree`. `list`: folders and status. `enter`: move this session to the folder of `branch`, created if missing. `spawn`: a new agent works on `task` in that folder, in a background tab. `done`: delete this folder and its local branch. `remove`: delete another branch and its folder. Both discard uncommitted changes and unpushed commits.",
    parameters: Type.Object({
      action: Type.Enum(["list", "enter", "spawn", "done", "remove"]),
      branch: Type.Optional(Type.String({ description: "e.g. feat/login" })),
      base: Type.Optional(
        Type.String({
          description:
            "Start point of a new branch. Default: the default branch",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description: "Prompt for the new agent, which has no context",
        }),
      ),
    }),
    outputSchema: Type.Object({
      worktrees: Type.Optional(
        Type.Array(
          Type.Object({
            branch: Type.Union([Type.String(), Type.Null()]),
            path: Type.String(),
            home: Type.Boolean({
              description: "True for the worktree of the default branch",
            }),
            changes: Type.Union([Type.Number(), Type.Null()], {
              description: "Changed files, or null when the path is missing",
            }),
            ahead: Type.Union([Type.Number(), Type.Null()]),
            behind: Type.Union([Type.Number(), Type.Null()]),
            tab: Type.Union([Type.String(), Type.Null()], {
              description: "Rex window ID of the branch's tab",
            }),
          }),
        ),
      ),
      path: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
      window_id: Type.Optional(Type.String()),
      block_id: Type.Optional(Type.String()),
    }),
    async execute(_id, { action, branch, base, task }, signal, _onUpdate, ctx) {
      const session = process.env.REX_SESSION;

      if (action === "list") {
        const repo = await openRepo(ctx.cwd, signal);
        const worktrees = await describeWorktrees(repo, signal);
        return reply(formatWorktrees(repo.root, worktrees), { worktrees });
      }

      if (action === "done") {
        const wt = await finishableWorktree(ctx.cwd, signal);
        pendingMove = {
          commandArgs: "done",
          continuation: `This session deleted the folder ${wt.path}${wt.branch ? ` and branch \`${wt.branch}\`` : ""}, and moved to the default-branch worktree at \`${wt.home}\`. Continue the task there.`,
        };
        return reply(
          `When this turn ends, ${wt.path}${wt.branch ? ` and branch ${wt.branch} are` : " is"} deleted, and the session moves to ${wt.home}.`,
          { path: wt.home, branch: wt.branch },
          true,
        );
      }

      if (!branch) throw new Error(`Pass \`branch\` to ${action}.`);

      if (action === "remove") {
        const removed = await removeBranch(
          await openRepo(ctx.cwd, signal),
          branch,
          await currentWorktree(ctx.cwd, signal),
          signal,
        );
        return reply(`${removed}${await closeTab(branch, signal)}`, {
          branch,
        });
      }

      if (action === "spawn") {
        if (!session)
          throw new Error("spawn needs Rex. This pi does not run inside Rex.");
        if (!task) throw new Error("Pass `task` to spawn.");
        const open = tabOf(await rexWindows(session, signal), branch);
        if (open)
          throw new Error(
            `Branch ${branch} already has a Rex tab, block ${firstBlock(open)}. Send the task to that agent instead.`,
          );
        const repo = await openRepo(ctx.cwd, signal);
        if (branch === repo.defaultBranch)
          throw new Error(
            `Branch ${branch} is the default branch. Spawn on another branch.`,
          );
        const wt = await ensureWorktree(repo, branch, base, signal);
        const tab = await openTab(
          session,
          branch,
          wt.path,
          ["pi", "--", task.startsWith("@") ? ` ${task}` : task],
          signal,
        );
        return reply(
          `${createdText(wt)} An agent started on the task in background Rex tab ${branch}, block ${tab.block_id}.`,
          { path: wt.path, branch, ...tab },
        );
      }

      const wt = await ensureWorktree(
        await openRepo(ctx.cwd, signal),
        branch,
        base,
        signal,
      );
      if (wt.path === (await currentWorktree(ctx.cwd, signal)))
        return reply(`Session is already in ${wt.path}.`, {
          path: wt.path,
          branch,
        });
      pendingMove = {
        commandArgs: branch,
        continuation: `This session moved to the worktree at \`${wt.path}\` on branch \`${branch}\`. Continue the task there.`,
      };
      return reply(
        `${createdText(wt)} When this turn ends, the session moves there.`,
        { path: wt.path, branch },
        true,
      );
    },
  });
}
