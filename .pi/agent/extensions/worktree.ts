import { existsSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { run } from "./shared/exec";

const WORKTREE_DIR = ".worktree";
const TOOL_NAME = "worktree";

interface Worktree {
  path: string;
  branch?: string;
}

interface PendingMove {
  commandArgs: string;
  continuation: string;
}

interface LinkedWorktree {
  root: string;
  path: string;
  branch: string;
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

async function listWorktrees(
  cwd: string,
  signal?: AbortSignal,
): Promise<Worktree[]> {
  const out = await git(cwd, ["worktree", "list", "--porcelain"], signal);
  return out.split("\n\n").map((block) => {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))!.slice(9);
    const ref = lines.find((l) => l.startsWith("branch "))?.slice(7);
    return { path, branch: ref?.replace(/^refs\/heads\//, "") };
  });
}

async function ensureWorktree(
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<{ path: string; created: boolean }> {
  await git(cwd, ["check-ref-format", "--branch", branch], signal);
  const worktrees = await listWorktrees(cwd, signal);
  const existing = worktrees.find((w) => w.branch === branch);
  if (existing) return { path: existing.path, created: false };

  const path = join(
    worktrees[0]!.path,
    WORKTREE_DIR,
    branch.replaceAll("/", "-"),
  );
  const hasLocal =
    (
      await run(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
        cwd,
      )
    ).code === 0;
  const remotes = hasLocal
    ? []
    : (
        await git(
          cwd,
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
      : ["worktree", "add", "-b", branch, path];
  await git(cwd, args, signal);
  return { path, created: true };
}

function currentWorktree(cwd: string, signal?: AbortSignal): Promise<string> {
  return git(cwd, ["rev-parse", "--show-toplevel"], signal);
}

async function finishableWorktree(
  cwd: string,
  signal?: AbortSignal,
): Promise<LinkedWorktree> {
  const worktrees = await listWorktrees(cwd, signal);
  const root = worktrees[0]!.path;
  const path = await currentWorktree(cwd, signal);
  if (path === root)
    throw new Error("This session is in the main checkout, not in a worktree.");
  const branch = worktrees.find((w) => w.path === path)?.branch;
  if (!branch)
    throw new Error(
      `The worktree at ${path} has a detached HEAD. Create a branch for its commits first.`,
    );
  const status = await git(path, ["status", "--porcelain"], signal);
  if (status) {
    const count = status.split("\n").length;
    throw new Error(
      `The worktree at ${path} has ${count} uncommitted or untracked ${count === 1 ? "file" : "files"}. Commit or stash them, then finish again.`,
    );
  }
  return { root, path, branch };
}

function removeIfEmpty(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
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

async function moveSession(
  ctx: ExtensionCommandContext,
  target: string,
  notice: string,
  continuation?: string,
): Promise<void> {
  await ctx.waitForIdle();
  const source = ctx.sessionManager.getSessionFile();
  if (!source)
    throw new Error("This session is not saved to disk, so it cannot move.");
  const sessionFile = existsSync(source)
    ? SessionManager.forkFrom(source, target).getSessionFile()
    : writeEmptySession(target);
  if (!sessionFile) throw new Error("pi created no session file");
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
  const { root, path, branch } = await finishableWorktree(ctx.cwd);
  await git(root, ["worktree", "remove", path]);
  removeIfEmpty(join(root, WORKTREE_DIR));
  await moveSession(
    ctx,
    root,
    `Removed worktree ${path}. Branch ${branch} is kept. Session moved to ${root}`,
    continuation,
  );
}

async function pickWorktree(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const worktrees = await listWorktrees(ctx.cwd);
  const root = worktrees[0]!.path;
  const here = await currentWorktree(ctx.cwd);
  const choices = new Map(
    worktrees.map((w) => [
      `${w.path === here ? "●" : " "} ${w.branch ?? "(detached)"}  ${relative(root, w.path) || "."}`,
      w.path,
    ]),
  );
  const label = await ctx.ui.select("Move session to worktree", [
    ...choices.keys(),
  ]);
  return label === undefined ? undefined : choices.get(label);
}

export default function (pi: ExtensionAPI) {
  let pendingMove: PendingMove | undefined;
  let completionCwd = process.cwd();

  const offerTool = (offered: boolean) => {
    const active = pi.getActiveTools();
    if (active.includes(TOOL_NAME) === offered) return;
    pi.setActiveTools(
      offered
        ? [...active, TOOL_NAME]
        : active.filter((name) => name !== TOOL_NAME),
    );
  };

  pi.on("session_start", (_event, ctx) => {
    completionCwd = ctx.cwd;
    offerTool(false);
  });

  pi.on("input", (event) => {
    if (/\bworktrees?\b|\bwt\b/i.test(event.text)) offerTool(true);
    return { action: "continue" };
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!pendingMove) {
      offerTool(false);
      return;
    }
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
      "Move this session to a branch's worktree under .worktree/, or /wt done to remove a clean worktree and move back",
    getArgumentCompletions: async (prefix) => {
      const r = await run(
        "git",
        ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        undefined,
        completionCwd,
        5_000,
      );
      if (r.code !== 0) return null;
      const done = {
        value: "done",
        label: "done",
        description:
          "Remove this clean worktree, keep its branch, move back to the main checkout",
      };
      return [
        done,
        ...r.stdout
          .split("\n")
          .filter(Boolean)
          .map((b) => ({ value: b, label: b })),
      ].filter((item) => item.value.startsWith(prefix.trim()));
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
        const target = commandArgs
          ? (await ensureWorktree(ctx.cwd, commandArgs)).path
          : await pickWorktree(ctx);
        if (!target) return;
        if (target === (await currentWorktree(ctx.cwd))) {
          ctx.ui.notify(`Session is already in ${target}`, "info");
          return;
        }
        await moveSession(
          ctx,
          target,
          `Session moved to ${target}`,
          continuation,
        );
      } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
      }
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Worktree",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    promptSnippet: "Move this session into or out of a git worktree",
    description:
      "Only for an explicit user request. `enter` moves this session into the worktree of `branch`, creating it if missing. `done` removes the current clean worktree, keeps its branch, and returns to the main checkout. Use instead of `git worktree`. End your turn after the call.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("enter"), Type.Literal("done")]),
      branch: Type.Optional(
        Type.String({ description: "Required for enter, e.g. feat/login" }),
      ),
    }),
    async execute(_id, { action, branch }, signal, _onUpdate, ctx) {
      if (action === "done") {
        const wt = await finishableWorktree(ctx.cwd, signal);
        pendingMove = {
          commandArgs: "done",
          continuation: `This session finished the worktree of branch \`${wt.branch}\` and moved back to the main checkout at \`${wt.root}\`. The worktree is removed and the branch is kept. Continue the task there.`,
        };
        return {
          content: [
            {
              type: "text",
              text: `The worktree at ${wt.path} is clean. When this turn ends, it is removed, branch ${wt.branch} is kept, and the session moves to ${wt.root}.`,
            },
          ],
          details: undefined,
          terminate: true,
        };
      }
      if (!branch) throw new Error("Pass `branch` to enter a worktree.");
      const { path, created } = await ensureWorktree(ctx.cwd, branch, signal);
      if (path === (await currentWorktree(ctx.cwd, signal)))
        return {
          content: [{ type: "text", text: `Session is already in ${path}.` }],
          details: undefined,
        };
      pendingMove = {
        commandArgs: branch,
        continuation: `This session moved to the worktree at \`${path}\` on branch \`${branch}\`. Continue the task there.`,
      };
      return {
        content: [
          {
            type: "text",
            text: `${created ? "Created" : "Found"} worktree ${path} on branch ${branch}. The session moves there when this turn ends.`,
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
  });
}
