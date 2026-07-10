// /yeet — stage, commit, and push. Side-channel LLM call for commit message
// (does NOT pollute main conversation). Leaves a short marker entry in
// history after success.

import {
  BorderedLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sideChannelComplete } from "./shared/llm";

const MSG_PROMPT =
  "Write a Conventional Commits message for the diff. Terse and exact: no fluff, why over what. The diff is the only source of truth for WHAT changed — base the subject and body entirely on it. A user hint (if present) may ONLY be consulted to disambiguate WHY (e.g. picking a scope, or explaining a non-obvious rationale in the body); never let it introduce, emphasize, or replace a description of a change that isn't actually in the diff. Format: `<type>(<scope>)!: <subject>` where type ∈ {feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}; scope optional; `!` only for breaking changes. Subject: imperative mood ('add', 'fix' — not 'added', 'adds'), lowercase, ≤50 chars when possible (hard cap 72), no trailing period, don't restate a file name the scope already names. Body: skip entirely when subject is self-explanatory; add only for non-obvious WHY, breaking changes, security fixes, data migrations, or reverts (these ALWAYS get a body — never subject-only); one blank line after subject, wrap at 72 chars, bullets `-` not `*`, MAY be multiple paragraphs. NEVER write: 'this commit', 'I', 'we', 'now', 'currently', 'as requested by', emoji, or any AI attribution. Optional footers one blank line after body, each `Token: value` or `Token #value`; tokens use `-` instead of spaces (e.g. `Reviewed-by`, `Refs: #123`, `Closes #42`), except `BREAKING CHANGE` which stays uppercase with a space. Recent commit subjects (if present) show this repo's established type/scope vocabulary and phrasing — match them; reuse an existing scope when the change touches the same area rather than inventing a new one. No fences, no preamble. Output ONLY the message.";

const YEET_MSG_TYPE = "yeet-marker";

// Commit message model — fixed regardless of the session model so cost and
// latency stay predictable. No reasoning budget needed for a commit message.
const YEET_MODEL_PROVIDER = "anthropic";
const YEET_MODEL_ID = "claude-sonnet-5";
const YEET_THINKING_ENABLED = false;

export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer(YEET_MSG_TYPE, (message, _opts, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(
      new Text(
        `${theme.fg("success", "✓ yeet")} ${message.content as string}`,
        0,
        0,
      ),
    );
    return box;
  });

  pi.registerCommand("yeet", {
    description: "Stage, commit, and push current repo changes",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/yeet requires interactive mode", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("/yeet: no model selected", "error");
        return;
      }
      const cwd = ctx.cwd;

      // Repo-root paths /yeet never stages, diffs, or commits (e.g. dotfiles'
      // stowed gitconfig gets dirtied by tools mid-session). Extend as needed.
      const IGNORED_PATHS = ["git/"];
      const EXCLUDE = IGNORED_PATHS.map((p) => `:(exclude,top)${p}`);

      // Force no ANSI color in diffs regardless of user gitconfig.
      const git = async (...gargs: string[]) => {
        const r = await pi.exec("git", ["-c", "color.ui=never", ...gargs], {
          cwd,
        });
        return {
          ok: r.code === 0,
          out: r.stdout.trim(),
          err: r.stderr.trim(),
          stdout: r.stdout,
          stderr: r.stderr,
        };
      };

      if (!(await git("rev-parse", "--git-dir")).ok) {
        ctx.ui.notify("/yeet: not a git repository", "error");
        return;
      }

      // Don't stage yet — diff working tree vs HEAD so an LLM cancel doesn't
      // leave the index dirty. Stage right before commit.
      const hasHead = (await git("rev-parse", "--verify", "HEAD")).ok;
      const wtStatus = (
        await git("status", "--porcelain", "--", ".", ...EXCLUDE)
      ).out;
      if (!wtStatus) {
        ctx.ui.notify("/yeet: nothing to commit", "warning");
        return;
      }

      // Make untracked files visible to `git diff` via intent-to-add, then
      // undo so we don't leave index state behind. Without this, brand-new
      // files are invisible in the diff and the commit message drifts.
      const untracked = (
        await git(
          "ls-files",
          "--others",
          "--exclude-standard",
          "--",
          ".",
          ...EXCLUDE,
        )
      ).out
        .split("\n")
        .filter(Boolean);
      if (untracked.length) await git("add", "-N", "--", ...untracked);
      let diffstat: string;
      let diff: string;
      try {
        // No HEAD yet (first commit): diff against the well-known empty tree
        // so the LLM sees a real diff instead of bare status lines.
        const base = hasHead
          ? "HEAD"
          : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
        const stat = await git("diff", "--stat", base, "--", ".", ...EXCLUDE);
        const full = await git("diff", base, "--", ".", ...EXCLUDE);
        diffstat = stat.ok ? stat.out : wtStatus;
        diff = full.ok ? full.out : wtStatus;
      } finally {
        if (untracked.length) await git("reset", "--", ...untracked);
      }
      const diffSnippet =
        diff.length > 6000 ? diff.slice(0, 6000) + "\n…(truncated)" : diff;
      const hint = args?.trim() ? `\nUser hint: ${args.trim()}\n` : "";

      // Recent commit subjects so the message matches the repo's established
      // type/scope vocabulary and phrasing.
      const log = await git("log", "-10", "--no-merges", "--format=%s");
      const historyBlock =
        log.ok && log.out
          ? `Recent commit subjects (style reference):\n${log.out}\n\n`
          : "";

      // Branch name often encodes ticket/scope (e.g. feat/auth-xyz).
      const branch = (await git("symbolic-ref", "--quiet", "--short", "HEAD"))
        .out;
      const branchBlock = branch ? `Current branch: ${branch}\n\n` : "";

      // 1) Side-channel LLM call for commit message (not in main session).
      //    Fixed to sonnet-5, no thinking — a commit message needs no
      //    reasoning budget, and pinning it keeps cost/latency predictable
      //    regardless of whatever model the session itself is using.
      const yeetModel =
        ctx.modelRegistry.find(YEET_MODEL_PROVIDER, YEET_MODEL_ID) ?? ctx.model;
      const message = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `yeet → ${yeetModel!.id}`,
          );
          loader.onAbort = () => done(null);
          (async (): Promise<string | null> => {
            const r = await sideChannelComplete(ctx, {
              systemPrompt: MSG_PROMPT,
              model: yeetModel,
              thinkingEnabled: YEET_THINKING_ENABLED,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `${hint}${branchBlock}${historyBlock}Diffstat:\n${diffstat}\n\nDiff:\n${diffSnippet}`,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ],
              signal: loader.signal,
            });
            if (r.ok) return r.text;
            if (r.reason === "aborted") return null;
            throw new Error(r.error ?? r.reason);
          })()
            .then(done)
            .catch((e) => {
              ctx.ui.notify(
                `yeet error: ${e instanceof Error ? e.message : String(e)}`,
                "error",
              );
              done(null);
            });
          return loader;
        },
      );

      if (!message) {
        ctx.ui.notify("/yeet cancelled", "info");
        return;
      }

      // Sanitize: strip wrapping quotes/backticks, common LLM prefix labels.
      const cleanMessage = message
        .replace(/^\s*(?:subject|title|commit(?:\s*message)?|message):\s*/i, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (!cleanMessage) {
        ctx.ui.notify("/yeet: empty commit message", "error");
        return;
      }

      // 2) Stage + commit deterministically.
      const add = await git("add", "-A", "--", ".", ...EXCLUDE);
      if (!add.ok) {
        ctx.ui.notify(`/yeet: git add failed: ${add.err}`, "error");
        return;
      }
      const commit = await git("commit", "-m", cleanMessage);
      if (!commit.ok) {
        // Pre-commit hooks usually write to stdout; surface both streams.
        const detail = [commit.stdout, commit.stderr]
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n");
        ctx.ui.notify("/yeet: commit failed (see history)", "error");
        pi.sendMessage({
          customType: YEET_MSG_TYPE,
          content: `commit failed:\n${detail || "(no output)"}`,
          display: true,
        });
        return;
      }
      const sha = (await git("rev-parse", "--short", "HEAD")).out;
      const subject = cleanMessage.split("\n")[0];

      // 3) Push. New branches have no upstream yet — retry with --set-upstream.
      let push = await git("push");
      if (!push.ok && /no upstream branch|--set-upstream/i.test(push.stderr)) {
        push = await git("push", "-u", "origin", "HEAD");
      }
      const pushNote = push.ok
        ? "pushed"
        : `push failed: ${
            [push.stdout, push.stderr]
              .map((s) => s.trim())
              .filter(Boolean)
              .join(" | ") || "(no output)"
          }`;
      if (!push.ok) ctx.ui.notify(`/yeet: ${pushNote}`, "error");

      // 4) Leave a small marker in history (one line; sent to LLM next turn).
      pi.sendMessage({
        customType: YEET_MSG_TYPE,
        content: `${sha} ${subject} (${pushNote})`,
        display: true,
      });
    },
  });
}
