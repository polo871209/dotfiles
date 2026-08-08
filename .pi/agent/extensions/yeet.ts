// /yeet — stage, commit, and push. Side-channel LLM call for commit message
// (does NOT pollute main conversation). Leaves a short marker entry in
// history after success.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { sideChannelWithLoader } from "./shared/llm";
import { barWidget } from "./shared/widget";

const MSG_PROMPT =
  "Write a Conventional Commits message for the diff. Output ONLY the raw commit message itself — never a preamble, restated instructions, reasoning, or analysis before it (e.g. never start with something like 'Looking at the diff, I need to understand...'). Terse and exact: no fluff, why over what. The diff is the only source of truth for WHAT changed — base the subject and body entirely on it. A user hint (if present) may ONLY be consulted to disambiguate WHY (e.g. picking a scope, or explaining a non-obvious rationale in the body); never let it introduce, emphasize, or replace a description of a change that isn't actually in the diff. Format: `<type>(<scope>)!: <subject>` where type ∈ {feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}; scope optional; `!` only for breaking changes. Subject: imperative mood ('add', 'fix' — not 'added', 'adds'), lowercase, ≤50 chars when possible (hard cap 72), no trailing period, don't restate a file name the scope already names. Body: skip entirely when subject is self-explanatory; add only for non-obvious WHY, breaking changes, security fixes, data migrations, or reverts (these ALWAYS get a body — never subject-only); one blank line after subject, wrap at 72 chars, bullets `-` not `*`, MAY be multiple paragraphs. NEVER write: 'this commit', 'I', 'we', 'now', 'currently', 'as requested by', emoji, or any AI attribution. Optional footers one blank line after body, each `Token: value` or `Token #value`; tokens use `-` instead of spaces (e.g. `Reviewed-by`, `Refs: #123`, `Closes #42`), except `BREAKING CHANGE` which stays uppercase with a space. Recent commit subjects (if present) show this repo's established type/scope vocabulary and phrasing — match them; reuse an existing scope when the change touches the same area rather than inventing a new one. No fences, no preamble. Output ONLY the message.";

const YEET_MSG_TYPE = "yeet-marker";
const YEET_WIDGET_KEY = "yeet-progress";

const YEET_PRIMARY_MODEL_PROVIDER = "anthropic";
const YEET_PRIMARY_MODEL_ID = "claude-sonnet-4-6";
const YEET_FALLBACK_MODEL_PROVIDER = "openai-codex";
const YEET_FALLBACK_MODEL_ID = "gpt-5.5";
const YEET_THINKING_ENABLED = false;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    ctx.ui.setWidget(YEET_WIDGET_KEY, undefined);
  });

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
      const primaryModel = ctx.modelRegistry.find(
        YEET_PRIMARY_MODEL_PROVIDER,
        YEET_PRIMARY_MODEL_ID,
      );
      const fallbackModel = ctx.modelRegistry.find(
        YEET_FALLBACK_MODEL_PROVIDER,
        YEET_FALLBACK_MODEL_ID,
      );
      const yeetModel =
        primaryModel && ctx.modelRegistry.hasConfiguredAuth(primaryModel)
          ? primaryModel
          : fallbackModel && ctx.modelRegistry.hasConfiguredAuth(fallbackModel)
            ? fallbackModel
            : undefined;
      if (!yeetModel) {
        ctx.ui.notify("/yeet: no configured commit-message model", "error");
        return;
      }
      const cwd = ctx.cwd;
      const steps = [
        "stage changes",
        "run pre-commit",
        `write commit message (${yeetModel.id})`,
        "commit",
        "push",
      ];
      const showProgress = (active: number, failed = false) => {
        ctx.ui.setWidget(
          YEET_WIDGET_KEY,
          barWidget([
            "yeet",
            ...steps.map((step, index) =>
              index < active
                ? `✓ ${step}`
                : index === active
                  ? `${failed ? "✗" : "→"} ${step}`
                  : `○ ${step}`,
            ),
          ]),
          { placement: "aboveEditor" },
        );
      };

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

      showProgress(0);
      const add = await git("add", "-A", "--", ".", ...EXCLUDE);
      if (!add.ok) {
        showProgress(0, true);
        ctx.ui.notify(`/yeet: git add failed: ${add.err}`, "error");
        return;
      }

      // Check hooks before spending an LLM call; rerun after hook formatting.
      showProgress(1);
      let hook = await git("hook", "run", "--ignore-missing", "pre-commit");
      const unstaged = await git("diff", "--quiet", "--", ".", ...EXCLUDE);
      if (!unstaged.ok) {
        const restage = await git("add", "-A", "--", ".", ...EXCLUDE);
        if (!restage.ok) {
          showProgress(1, true);
          ctx.ui.notify(`/yeet: git add failed: ${restage.err}`, "error");
          return;
        }
        hook = await git("hook", "run", "--ignore-missing", "pre-commit");
      }
      if (!hook.ok) {
        showProgress(1, true);
        const detail = [hook.stdout, hook.stderr]
          .map((s) => s.trim())
          .filter(Boolean)
          .join("\n");
        ctx.ui.notify("/yeet: pre-commit failed (see history)", "error");
        pi.sendMessage({
          customType: YEET_MSG_TYPE,
          content: `pre-commit failed:\n${detail || "(no output)"}`,
          display: true,
        });
        return;
      }

      // No HEAD yet (first commit): diff against the well-known empty tree.
      const base = hasHead
        ? "HEAD"
        : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const stat = await git(
        "diff",
        "--cached",
        "--stat",
        base,
        "--",
        ".",
        ...EXCLUDE,
      );
      const full = await git("diff", "--cached", base, "--", ".", ...EXCLUDE);
      const diffstat = stat.ok ? stat.out : wtStatus;
      const diff = full.ok ? full.out : wtStatus;
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
      showProgress(2);
      const message = await sideChannelWithLoader(
        ctx,
        `yeet → ${yeetModel.id}`,
        {
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
        },
      );

      if (!message) {
        showProgress(2, true);
        ctx.ui.notify("/yeet cancelled", "info");
        return;
      }

      // Sanitize: drop any preamble/reasoning before the actual subject line
      // (models sometimes think out loud first, e.g. "Looking at the diff,
      // I need to understand..."), then strip wrapping quotes/backticks and
      // common LLM prefix labels.
      const COMMIT_TYPES =
        "feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert";
      const subjectLineRe = new RegExp(
        `^(?:${COMMIT_TYPES})(?:\\([\\w.-]+\\))?!?:\\s`,
        "i",
      );
      const lines = message.trim().split("\n");
      const subjectIndex = lines.findIndex((l) => subjectLineRe.test(l.trim()));
      const trimmedMessage =
        subjectIndex > 0 ? lines.slice(subjectIndex).join("\n") : message;
      const cleanMessage = trimmedMessage
        .replace(/^\s*(?:subject|title|commit(?:\s*message)?|message):\s*/i, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (!cleanMessage) {
        showProgress(2, true);
        ctx.ui.notify("/yeet: empty commit message", "error");
        return;
      }

      // 2) Avoid rerunning the hook after validating this exact index.
      showProgress(3);
      const commit = await git("commit", "--no-verify", "-m", cleanMessage);
      if (!commit.ok) {
        showProgress(3, true);
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
      showProgress(4);
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
      if (!push.ok) {
        showProgress(4, true);
        ctx.ui.notify(`/yeet: ${pushNote}`, "error");
      } else {
        ctx.ui.setWidget(YEET_WIDGET_KEY, undefined);
      }

      // 4) Leave a small marker in history (one line; sent to LLM next turn).
      pi.sendMessage({
        customType: YEET_MSG_TYPE,
        content: `${sha} ${subject} (${pushNote})`,
        display: true,
      });
    },
  });
}
