// /gate — validate the current branch in the background, then land the result.
//
// Spins out a background pi agent (full toolset + harness extensions, same as
// the main agent) that works in a dedicated git worktree on a temp branch off
// the current branch, runs a no-mistakes-style pipeline (intent → rebase →
// review → diagnostics → test → comment-cleanup → lint, auto-fixing safe
// issues), and on a clean verdict updates
// the original branch to the gated result. Your checkout is never blocked: keep
// working or switch branches, and the gate lands the branch once it's no longer
// checked out. Git refuses to move a checked-out branch ref, so if you stay on
// the branch the gated work is left on the temp branch for you to land manually.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractText } from "./shared/message";

// Watchdogs for a background gate that hangs. idle: no event AND no tool in
// flight (a long test emits start, then silence until end, so gate on "no tool
// running"). wall-clock: absolute cap that also catches a hung tool.
const IDLE_TIMEOUT_MS = 180_000;
const MAX_DURATION_MS = 1_800_000;
const HARD_KILL_MS = 3_000;
// A crash before the close handler runs can orphan a worktree; anything older
// than the wall-clock cap is past the watchdog, so reaping it can't kill a live
// run.
const ORPHAN_AGE_MS = MAX_DURATION_MS + 5 * 60_000;

// In-session guard against a second gate on the same branch.
const active = new Set<string>();

const GATE_SYSTEM_PROMPT = (defaultRef: string) =>
  `You are a release gate running inside a dedicated git worktree on a temp branch. Validate and fix THIS worktree's changes. Do NOT touch any other branch, do NOT remove this worktree, do NOT push.

Steps in order. Each PASSES, applies a SAFE auto-fix (commit it here), or ESCALATES (needs a human call):

1. intent      - establish what this branch is FOR before changing anything: read the commits and the diff vs ${defaultRef} (use supplied author intent if given) and state the purpose in one sentence. Carry it as context through every later step.
2. rebase      - git fetch, then rebase this branch onto ${defaultRef}. Resolve only mechanical conflicts; ESCALATE the rest.
3. review      - read the full diff vs ${defaultRef}. Judge it against the stated intent. Flag correctness, reliability, security issues. ESCALATE anything intent-sensitive (questioning a deliberate design/product choice, undoing an intentional add/remove). Never silently rewrite intent.
4. diagnostics - run lsp_diagnostics over the changed files. Auto-fix every error/warning at the root cause (no suppress directives). ESCALATE anything that can't be fixed without changing intent.
5. test        - detect and run the project's test command. Auto-fix mechanical failures. ESCALATE a real behavior gap or an undeterminable command.
6. comments    - review comments in the changed code and clean them to a concise style: WHY not WHAT, drop redundant/obvious comments, drop history ("replaces", "legacy", "previously"), no decorative dividers or banners, no em-dashes. Edit comments only, never behavior. Do NOT add docs or doc-comments.
7. lint        - detect and run linters/formatters; apply safe fixes.

Rules:
- AUTO-FIX = objective, mechanical, no intent change. Commit here with message prefix "gate(<step>): <summary>".
- ESCALATE = anything needing human judgment.

Write a concise human report. Then, as the LAST line of your final message, emit EXACTLY one machine-readable line:
  GATE_RESULT: {"verdict":"green"|"attention","summary":"<one line>","findings":[{"step":"...","severity":"error"|"warning"|"info","action":"auto-fix"|"ask-user"|"no-op","desc":"..."}]}
verdict is "green" ONLY if every step passed or was safely auto-fixed and no finding needs a human call.`;

interface GateResult {
  verdict: string;
  summary?: string;
  findings?: {
    step?: string;
    severity?: string;
    action?: string;
    desc?: string;
  }[];
}

function parseResult(report: string): GateResult | null {
  const m = report.match(/^GATE_RESULT:\s*(\{.*\})\s*$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as GateResult;
  } catch {
    return null;
  }
}

const stripResultLine = (s: string) =>
  s.replace(/^GATE_RESULT:.*$/m, "").trim();

// Kill the child's whole process group (it spawns grandchildren: nvim, tests).
function killGroup(
  child: { pid?: number; kill: (s: NodeJS.Signals) => boolean },
  sig: NodeJS.Signals,
) {
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      /* group gone — fall through */
    }
  }
  try {
    child.kill(sig);
  } catch {
    /* already dead */
  }
}

type Git = (
  ...g: string[]
) => Promise<{ ok: boolean; out: string; err: string }>;

export default function (pi: ExtensionAPI) {
  const makeGit =
    (cwd: string): Git =>
    async (...g: string[]) => {
      const r = await pi.exec("git", ["-c", "color.ui=never", ...g], { cwd });
      return { ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() };
    };

  // Reap worktrees/branches left by a gate whose session crashed before its
  // close handler could clean up. Only stale (past-watchdog) gate worktrees are
  // touched, so a gate still running in another session is left alone.
  const reapOrphans = async (cwd: string) => {
    const git = makeGit(cwd);
    if (!(await git("rev-parse", "--git-dir")).ok) return;
    await git("worktree", "prune");
    const list = (await git("worktree", "list", "--porcelain")).out;
    for (const block of list.split("\n\n")) {
      const wpath = block.match(/^worktree (.+)$/m)?.[1];
      const ref = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
      if (!wpath || !ref?.startsWith("gate/")) continue;
      if (!path.basename(wpath).startsWith("pi-gate-")) continue;
      let stale = true;
      try {
        stale = Date.now() - fs.statSync(wpath).mtimeMs > ORPHAN_AGE_MS;
      } catch {
        stale = true; // dir gone — metadata-only orphan
      }
      if (!stale) continue;
      await git("worktree", "remove", "--force", wpath);
      await git("branch", "-D", ref);
    }
  };

  pi.on("session_start", (_e, ctx) => void reapOrphans(ctx.cwd));

  pi.registerCommand("gate", {
    description:
      "Validate the current branch in a background agent, then land it",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const git = makeGit(cwd);

      if (!(await git("rev-parse", "--git-dir")).ok) {
        ctx.ui.notify("/gate: not a git repository", "error");
        return;
      }
      const branchRes = await git("symbolic-ref", "--quiet", "--short", "HEAD");
      if (!branchRes.ok) {
        ctx.ui.notify("/gate: detached HEAD, no branch to gate", "error");
        return;
      }
      const branch = branchRes.out;
      if (active.has(branch)) {
        ctx.ui.notify(`/gate already running on '${branch}'`, "warning");
        return;
      }

      // Resolve the remote's default branch authoritatively (no hardcoded
      // name): the locally cached origin/HEAD, else ask the remote directly.
      let def = (
        await git(
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        )
      ).out.replace(/^origin\//, "");
      if (!def) {
        const sym = await git("ls-remote", "--symref", "origin", "HEAD");
        def = sym.out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m)?.[1] ?? "";
      }
      if (!def) {
        for (const cand of ["main", "master"]) {
          if ((await git("rev-parse", "--verify", `origin/${cand}`)).ok) {
            def = cand;
            break;
          }
        }
      }
      if (!def) {
        ctx.ui.notify("/gate: cannot determine default branch", "error");
        return;
      }
      const defaultRef = `origin/${def}`;

      // Fetch fresh so the no-diff check and the agent's rebase see latest.
      await git("fetch", "origin", def);

      const ahead = await git("rev-list", "--count", `${defaultRef}..HEAD`);
      if (ahead.ok && ahead.out === "0") {
        ctx.ui.notify(
          `/gate: nothing to gate (no commits ahead of ${defaultRef})`,
          "warning",
        );
        return;
      }

      const startSha = (await git("rev-parse", "HEAD")).out;
      if ((await git("status", "--porcelain")).out) {
        ctx.ui.notify(
          "/gate: uncommitted changes won't be gated (gating HEAD)",
          "warning",
        );
      }

      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const tmpBranch = `gate/${branch}-${ts}`;
      const wtDir = path.join(os.tmpdir(), `pi-gate-${ts}`);

      const add = await git("worktree", "add", "-b", tmpBranch, wtDir, "HEAD");
      if (!add.ok) {
        ctx.ui.notify(`/gate: worktree add failed: ${add.err}`, "error");
        return;
      }
      active.add(branch);

      const intent = args?.trim();
      const task = intent
        ? `Gate this worktree. Author intent: ${intent}`
        : "Gate this worktree. Infer intent from the diff.";

      const child = spawn(
        "pi",
        [
          "-p",
          task,
          "--mode",
          "json",
          "--no-session",
          "--system-prompt",
          GATE_SYSTEM_PROMPT(defaultRef),
        ],
        {
          cwd: wtDir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: true,
          // Recursion guard only — disables the `subagent` tool. All other
          // tools and harness extensions (lsp, eval, codegraph, …) load.
          env: { ...process.env, PI_IS_SUBAGENT: "1" },
        },
      );
      child.unref();

      let outBuf = "";
      let stderrBuf = "";
      let report = "";
      let lastEventAt = Date.now();
      let runningTools = 0;
      let killedReason = "";
      let exited = false;

      const watchdog = setInterval(() => {
        if (exited || killedReason) return;
        const now = Date.now();
        if (now - lastEventAt > MAX_DURATION_MS) killedReason = "timeout";
        else if (runningTools === 0 && now - lastEventAt > IDLE_TIMEOUT_MS)
          killedReason = "idle";
        if (killedReason) {
          killGroup(child, "SIGTERM");
          const t = setTimeout(() => {
            if (!exited) killGroup(child, "SIGKILL");
          }, HARD_KILL_MS);
          t.unref?.();
        }
      }, 5_000);
      watchdog.unref?.();

      child.stdout.on("data", (c: Buffer) => {
        outBuf += c.toString("utf-8");
        let i: number;
        while ((i = outBuf.indexOf("\n")) >= 0) {
          const line = outBuf.slice(0, i);
          outBuf = outBuf.slice(i + 1);
          if (!line.trim()) continue;
          lastEventAt = Date.now();
          let ev: {
            type?: string;
            message?: { role?: string; content?: unknown };
          };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "tool_execution_start") runningTools++;
          else if (ev.type === "tool_execution_end")
            runningTools = Math.max(0, runningTools - 1);
          else if (
            ev.type === "message_end" &&
            ev.message?.role === "assistant"
          ) {
            const text = extractText(ev.message.content);
            if (text.trim()) report = text;
          }
        }
      });
      child.stderr.on("data", (c: Buffer) => {
        stderrBuf += c.toString("utf-8");
      });

      child.on("error", (err) => {
        ctx.ui.notify(`/gate failed to start: ${err.message}`, "error");
      });

      child.on("close", async (code) => {
        exited = true;
        clearInterval(watchdog);
        active.delete(branch);

        const result = parseResult(report);
        const human = stripResultLine(report);
        const resultSha = (await git("rev-parse", tmpBranch)).out;
        const removeWt = () => git("worktree", "remove", "--force", wtDir);

        const finish = async (note: string, dropBranch: boolean) => {
          await removeWt();
          if (dropBranch) await git("branch", "-D", tmpBranch);
          const body =
            human ||
            (killedReason
              ? `gate ${killedReason === "timeout" ? "exceeded its time budget" : "stalled"} and was stopped.`
              : `gate exited (${code}).`) +
              (stderrBuf.trim() ? `\n\n${stderrBuf.trim().slice(-1000)}` : "");
          pi.sendUserMessage(
            `Background /gate (${branch}):\n\n${body}\n\n${note}`,
            {
              deliverAs: "followUp",
            },
          );
        };

        if (killedReason) {
          await finish(
            `Stopped (${killedReason}). Partial work left on '${tmpBranch}'.`,
            false,
          );
          return;
        }
        if (!result || result.verdict !== "green") {
          const why = !result
            ? "no machine-readable verdict"
            : "NEEDS ATTENTION";
          await finish(`Verdict: ${why}. Work left on '${tmpBranch}'.`, false);
          return;
        }

        // Land: only if the source branch hasn't moved and isn't checked out.
        const nowSha = (await git("rev-parse", branch)).out;
        if (nowSha !== startSha) {
          await finish(
            `'${branch}' moved since gate started — not landing. Gated result on '${tmpBranch}'.`,
            false,
          );
          return;
        }
        const wtList = (await git("worktree", "list", "--porcelain")).out;
        if (wtList.includes(`branch refs/heads/${branch}\n`)) {
          await finish(
            `GREEN, but '${branch}' is still checked out so its ref can't move. ` +
              `Switch off it, then: git checkout ${branch} && git reset --hard ${tmpBranch} ` +
              `(gated result on '${tmpBranch}').`,
            false,
          );
          return;
        }
        const land = await git(
          "update-ref",
          `refs/heads/${branch}`,
          resultSha,
          startSha,
        );
        if (!land.ok) {
          await finish(
            `Land failed: ${land.err}. Gated result on '${tmpBranch}'.`,
            false,
          );
          return;
        }
        await finish(
          `Landed on '${branch}' (${startSha.slice(0, 8)} → ${resultSha.slice(0, 8)}).`,
          true,
        );
      });

      ctx.ui.notify(`/gate running on '${branch}' in the background`, "info");
    },
  });
}
