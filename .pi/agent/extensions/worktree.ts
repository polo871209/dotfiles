import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Loader } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./shared/error";
import { run } from "./shared/exec";

const BARE_DIR = ".bare";
const TOOL_NAME = "worktree";

type ShowRunning = (step: string | undefined) => void;

interface Worktree {
  path: string;
  branch?: string;
}

interface Repo {
  root: string;
  defaultBranch: string;
  worktrees: Worktree[];
}

interface EnsuredWorktree {
  path: string;
  branch: string;
  report: string;
}

interface PendingMove {
  commandArgs: string;
  continuation: string;
}

interface LinkedWorktree {
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

const RexWindowList = Type.Object({
  windows: Type.Array(
    Type.Object({
      window_id: Type.String(),
      label: Type.String(),
      layers: Type.Array(
        Type.Object({ blocks: Type.Array(Type.Object({ block_id: Type.String() })) }),
      ),
    }),
  ),
});

type RexWindow = Static<typeof RexWindowList>["windows"][number];

const CreatedWindow = Type.Object({
  window_id: Type.String(),
  block_ids: Type.Array(Type.String(), { minItems: 1 }),
});

interface Tab {
  window_id: string;
  block_id: string;
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const r = await run("git", args, signal, cwd, 60_000);

  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);

  return r.stdout.trim();
}

function bareRoot(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;

  for (let dir = realpathSync(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, BARE_DIR))) return dir;

    if (dir === dirname(dir)) return undefined;
  }
}

async function listWorktrees(root: string, signal?: AbortSignal): Promise<Worktree[]> {
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

async function gitWt(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ out: string; report: string }> {
  const r = await run("git", ["wt", ...args], signal, cwd, 60_000);
  const report = r.stderr.trim().replace(/\n/g, " ");

  if (r.code !== 0) throw new Error(report || `git wt ${args.join(" ")} failed`);

  return { out: r.stdout.trim(), report };
}

async function ensureWorktree(
  cwd: string,
  branch: string,
  base?: string,
  signal?: AbortSignal,
): Promise<EnsuredWorktree> {
  if (branch === "done") throw new Error("A branch named done conflicts with `git wt done`.");
  const { out, report } = await gitWt(cwd, [branch, ...(base ? [base] : [])], signal);

  return { path: out, branch, report };
}

const reportOf = (wt: EnsuredWorktree) =>
  wt.report || `Found worktree ${wt.path} on branch ${wt.branch}.`;

async function currentWorktree(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await run("git", ["rev-parse", "--show-toplevel"], signal, cwd);

  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function finishableWorktree(cwd: string, signal?: AbortSignal): Promise<LinkedWorktree> {
  const repo = await openRepo(cwd, signal);
  const path = await currentWorktree(cwd, signal);

  if (!path) throw new Error(`This session is in ${cwd}, which is not a branch folder.`);
  const branch = repo.worktrees.find((w) => w.path === path)?.branch;

  if (branch === repo.defaultBranch)
    throw new Error(
      `This session is in the worktree of the default branch ${repo.defaultBranch}, which stays.`,
    );
  const home = await ensureWorktree(cwd, repo.defaultBranch, undefined, signal);

  return { home: home.path, path, branch };
}

async function removeWorktree(cwd: string, target: string, signal?: AbortSignal): Promise<string> {
  return (await gitWt(cwd, ["done", target], signal)).report;
}

async function removeOtherWorktree(
  cwd: string,
  target: string,
  signal?: AbortSignal,
): Promise<string> {
  const repo = await openRepo(cwd, signal);
  const here = await currentWorktree(cwd, signal);
  const asPath = resolve(cwd, target);

  const folder =
    repo.worktrees.find((w) => w.branch === target)?.path ??
    (existsSync(asPath) ? realpathSync(asPath) : undefined);

  if (here && folder === here)
    throw new Error("This session is in that folder. Use `done` without a branch.");

  return removeWorktree(cwd, target, signal);
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
    throw new Error(`rex ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}`);

  return r.stdout;
}

async function rexWindows(session: string, signal?: AbortSignal): Promise<RexWindow[]> {
  const out = await rex(["window", "ls", "--json", "-s", session], signal);

  const list = JSON.parse(out);

  if (!Value.Check(RexWindowList, list))
    throw new Error(`rex window ls: unexpected output: ${out}`);

  return list.windows;
}

const tabOf = (windows: RexWindow[], branch: string) => windows.find((w) => w.label === branch);

const firstBlock = (window: RexWindow) => window.layers[0]?.blocks[0]?.block_id ?? "";

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

  const created = JSON.parse(out);

  if (!Value.Check(CreatedWindow, created))
    throw new Error(`rex window new: unexpected output: ${out}`);

  return { window_id: created.window_id, block_id: created.block_ids[0] };
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

async function describeWorktrees(repo: Repo, signal?: AbortSignal): Promise<WorktreeInfo[]> {
  const session = process.env.REX_SESSION;
  const windows = session ? await rexWindows(session, signal).catch(() => []) : [];

  return Promise.all(
    repo.worktrees.map(async (w) => {
      const status = await run("git", ["status", "--porcelain"], signal, w.path);

      const counts = w.branch
        ? await run(
            "git",
            ["rev-list", "--left-right", "--count", `origin/${repo.defaultBranch}...${w.branch}`],
            signal,
            repo.root,
          )
        : undefined;

      const [behind, ahead] =
        counts?.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];

      const tab = w.branch ? tabOf(windows, w.branch) : undefined;

      return {
        branch: w.branch ?? null,
        path: w.path,
        home: w.branch === repo.defaultBranch,
        changes: status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : null,
        ahead: ahead ?? null,
        behind: behind ?? null,
        tab: tab?.window_id ?? null,
      };
    }),
  );
}

function folderNote(root: string, w: { path: string; branch?: string | null }): string | undefined {
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

function cloneSession(ctx: ExtensionCommandContext, target: string): string {
  const source = ctx.sessionManager.getSessionFile();

  if (!source) throw new Error("This session is not saved to disk, so it cannot be cloned.");
  const leaf = ctx.sessionManager.getLeafId();

  if (!existsSync(source) || !leaf) return writeEmptySession(target);

  const clone = SessionManager.open(
    source,
    SessionManager.create(target).getSessionDir(),
    target,
  ).createBranchedSession(leaf);

  // pi writes a branched session only when its active path has an assistant message.
  return clone && existsSync(clone) ? clone : writeEmptySession(target);
}

function runningWidget(ctx: ExtensionCommandContext): ShowRunning {
  return (step) =>
    ctx.ui.setWidget(
      "wt",
      step === undefined
        ? undefined
        : (tui, theme) => {
            const loader = new Loader(
              tui,
              (s) => theme.fg("accent", s),
              (s) => theme.fg("muted", s),
              `/wt: ${step}`,
            );

            return Object.assign(loader, { dispose: () => loader.stop() });
          },
    );
}

async function waitForAgent(ctx: ExtensionCommandContext, showRunning: ShowRunning): Promise<void> {
  if (ctx.isIdle()) return;
  showRunning("waiting for the agent to finish its turn");
  await ctx.waitForIdle();
}

async function switchToSession(
  ctx: ExtensionCommandContext,
  sessionFile: string,
  notice: string,
  continuation?: string,
): Promise<boolean> {
  const { cancelled } = await ctx.switchSession(sessionFile, {
    withSession: async (next) => {
      next.ui.notify(notice);

      if (continuation)
        await next.sendMessage(
          { customType: "worktree", content: continuation, display: true },
          { triggerTurn: true },
        );
    },
  });

  return !cancelled;
}

async function finishWorktree(
  ctx: ExtensionCommandContext,
  showRunning: ShowRunning,
  continuation?: string,
): Promise<boolean> {
  await waitForAgent(ctx, showRunning);
  showRunning("checking this worktree");
  const linked = await finishableWorktree(ctx.cwd);
  showRunning(`copying the session to ${linked.home}`);
  const sessionFile = cloneSession(ctx, linked.home);
  showRunning(`removing ${linked.path}${linked.branch ? ` and branch ${linked.branch}` : ""}`);
  const removed = await removeWorktree(linked.home, linked.path);

  if (linked.branch) await clearTabLabel(linked.branch).catch(() => {});
  showRunning(`moving the session to ${linked.home}`);

  return switchToSession(
    ctx,
    sessionFile,
    `${removed} Session cloned to ${linked.home}`,
    continuation,
  );
}

async function pickWorktree(ctx: ExtensionCommandContext): Promise<Worktree | undefined> {
  const { root, worktrees } = await openRepo(ctx.cwd);
  const here = await currentWorktree(ctx.cwd);

  const choices = new Map(
    worktrees.map((w) => [
      [w.path === here ? "●" : " ", w.branch ?? "(detached)", folderNote(root, w)]
        .filter(Boolean)
        .join(" "),
      w,
    ]),
  );

  const label = await ctx.ui.select("Move session to worktree", [...choices.keys()]);

  return label === undefined ? undefined : choices.get(label);
}

const reply = (text: string, structuredContent: ToolData, terminate = false) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
  structuredContent,
  terminate,
});

export default function (pi: ExtensionAPI) {
  const { PI_CWD_FILE, PI_CWD_SHELL } = process.env;

  const shellCwdFile =
    PI_CWD_FILE && Number(PI_CWD_SHELL) === process.ppid ? PI_CWD_FILE : undefined;

  let pendingMove: PendingMove | undefined;

  const queueMove = (move: PendingMove) => {
    if (pendingMove)
      throw new Error(
        `This turn already runs /wt ${pendingMove.commandArgs} when it ends. End the turn, then call worktree again from the new folder.`,
      );
    pendingMove = move;
  };

  pi.on("tool_call", () => {
    if (!pendingMove) return;

    return {
      block: true,
      reason: `The session moves with /wt ${pendingMove.commandArgs} when this turn ends, and the task continues there. End the turn now.`,
      terminate: true,
    };
  });

  const offerTool = (offered: boolean) => {
    const active = pi.getActiveTools();

    if (active.includes(TOOL_NAME) === offered) return;
    pi.setActiveTools(
      offered ? [...active, TOOL_NAME] : active.filter((name) => name !== TOOL_NAME),
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
      "Move this session to a branch's worktree, created from [base] if missing, or /wt done [branch] to delete a branch and its folder",
    getArgumentCompletions: async (prefix) => {
      const r = await run(
        "git",
        ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"],
        undefined,
        process.cwd(),
        5_000,
      );

      if (r.code !== 0) return null;
      const refs = r.stdout.split("\n");
      const local = refs.flatMap((ref) => (ref.startsWith("refs/heads/") ? [ref.slice(11)] : []));
      const doneArg = prefix.match(/^done\s+(.*)$/)?.[1];

      if (doneArg !== undefined)
        return fuzzyFilter(
          local.map((b) => ({ value: `done ${b}`, label: b })),
          doneArg,
          (item) => item.label,
        );

      const remote = refs.flatMap((ref) => {
        const b = ref.startsWith("refs/remotes/origin/") ? ref.slice(20) : "";

        return b && b !== "HEAD" && !local.includes(b) ? [b] : [];
      });

      return fuzzyFilter(
        [
          {
            value: "done",
            label: "done",
            description:
              "Delete this folder and its branch, discarding changes, and move back to the default branch",
          },
          ...local.map((b) => ({ value: b, label: b })),
          ...remote.map((b) => ({
            value: b,
            label: b,
            description: "remote branch, new folder",
          })),
        ],
        prefix,
        (item) => item.value,
      );
    },
    handler: async (args, ctx) => {
      const commandArgs = args.trim();

      const continuation =
        pendingMove?.commandArgs === commandArgs ? pendingMove.continuation : undefined;

      pendingMove = undefined;

      if (!commandArgs && !ctx.hasUI) {
        ctx.ui.notify("Usage: /wt <branch> [base] or /wt done [branch]", "error");

        return;
      }

      const showRunning = runningWidget(ctx);
      let moved = false;

      try {
        const [first, second] = commandArgs.split(/\s+/);

        if (first === "done" && !second) {
          moved = await finishWorktree(ctx, showRunning, continuation);

          return;
        }

        if (first === "done") {
          showRunning(`removing branch ${second} and its folder`);
          const removed = await removeOtherWorktree(ctx.cwd, second);
          ctx.ui.notify(`${removed}${await closeTab(second)}`);

          return;
        }

        let report = "";
        let target: Worktree | undefined;

        if (first) {
          showRunning(`preparing the worktree of ${first}`);
          const wt = await ensureWorktree(ctx.cwd, first, second);
          report = wt.report && `${wt.report} `;
          target = wt;
        } else target = await pickWorktree(ctx);

        if (!target) return;

        if (target.path === (await currentWorktree(ctx.cwd))) {
          ctx.ui.notify(`Session is already in ${target.path}`);

          return;
        }

        await waitForAgent(ctx, showRunning);
        showRunning(`moving the session to ${target.path}`);
        moved = await switchToSession(
          ctx,
          cloneSession(ctx, target.path),
          `${report}Session cloned to ${target.path}`,
          continuation,
        );
      } catch (e) {
        ctx.ui.notify(errorMessage(e), "error");
      } finally {
        // After a session switch, pi has cleared the widget, and this ctx is stale and throws.
        if (!moved) showRunning(undefined);
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
      "One folder per branch in this repo. Call `enter` before the first edit when the task belongs to an existing branch, or when the user asks for a new branch. Call `spawn` only when the user asks for a background agent. Use it instead of `git worktree` or switching branches in this folder. `list`: folders and status. `enter`: move this session to the folder of `branch`, created if missing. `spawn`: a new agent works on `task` in that folder, in a background tab. `done`: delete this folder and its local branch. `remove`: delete another branch and its folder. Both discard uncommitted changes and unpushed commits.",
    parameters: Type.Object({
      action: Type.Enum(["list", "enter", "spawn", "done", "remove"]),
      branch: Type.Optional(Type.String({ description: "e.g. feat/login" })),
      base: Type.Optional(
        Type.String({
          description: "Start point of a new branch. Default: the default branch",
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
        queueMove({
          commandArgs: "done",
          continuation: `This session deleted the folder ${wt.path}${wt.branch ? ` and branch \`${wt.branch}\`` : ""}, and moved to the default-branch worktree at \`${wt.home}\`. Continue the task there.`,
        });

        return reply(
          `When this turn ends, ${wt.path}${wt.branch ? ` and branch ${wt.branch} are` : " is"} deleted, and the session moves to ${wt.home}.`,
          { path: wt.home, branch: wt.branch },
          true,
        );
      }

      if (!branch) throw new Error(`Pass \`branch\` to ${action}.`);

      if (action === "remove") {
        const removed = await removeOtherWorktree(ctx.cwd, branch, signal);

        return reply(`${removed}${await closeTab(branch, signal)}`, {
          branch,
        });
      }

      if (action === "spawn") {
        if (!session) throw new Error("spawn needs Rex. This pi does not run inside Rex.");

        if (!task) throw new Error("Pass `task` to spawn.");
        const open = tabOf(await rexWindows(session, signal), branch);

        if (open)
          throw new Error(
            `Branch ${branch} already has a Rex tab, block ${firstBlock(open)}. Send the task to that agent instead.`,
          );
        const repo = await openRepo(ctx.cwd, signal);

        if (branch === repo.defaultBranch)
          throw new Error(`Branch ${branch} is the default branch. Spawn on another branch.`);
        const wt = await ensureWorktree(ctx.cwd, branch, base, signal);

        const tab = await openTab(
          session,
          branch,
          wt.path,
          ["pi", "--", task.startsWith("@") ? ` ${task}` : task],
          signal,
        );

        return reply(
          `${reportOf(wt)} An agent started on the task in background Rex tab ${branch}, block ${tab.block_id}.`,
          { path: wt.path, branch, ...tab },
        );
      }

      const wt = await ensureWorktree(ctx.cwd, branch, base, signal);

      if (wt.path === (await currentWorktree(ctx.cwd, signal)))
        return reply(`Session is already in ${wt.path}.`, {
          path: wt.path,
          branch,
        });
      queueMove({
        commandArgs: branch,
        continuation: `This session moved to the worktree at \`${wt.path}\` on branch \`${branch}\`. Continue the task there.`,
      });

      return reply(
        `${reportOf(wt)} When this turn ends, the session moves there.`,
        { path: wt.path, branch },
        true,
      );
    },
  });
}
