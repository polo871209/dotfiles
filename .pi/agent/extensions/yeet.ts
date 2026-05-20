// /yeet — stage, commit, and push. Side-channel LLM call for commit message
// (does NOT pollute main conversation). Leaves a short marker entry in
// history after success.

import { complete } from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const MSG_PROMPT =
  "Write a Conventional Commits message for the diff (see conventionalcommits.org v1.0.0). Format: `<type>(<scope>)!: <subject>` where type ∈ {feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}; scope optional; `!` only for breaking changes. Subject: imperative mood, lowercase, ≤72 chars, no trailing period. Optional body after one blank line only if change is non-obvious; body MAY be multiple newline-separated paragraphs. Optional footers one blank line after body, each `Token: value` or `Token #value`; tokens use `-` instead of spaces (e.g. `Reviewed-by`, `Refs: #123`), except `BREAKING CHANGE` which stays uppercase with a space. No fences, no preamble. Output ONLY the message.";

const YEET_MSG_TYPE = "yeet-marker";

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
    description: "Stage and commit current repo changes",
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
      const wtStatus = (await git("status", "--porcelain")).out;
      if (!wtStatus) {
        ctx.ui.notify("/yeet: nothing to commit", "warning");
        return;
      }

      const diffstat = hasHead
        ? (await git("diff", "HEAD", "--stat")).out
        : wtStatus;
      const diff = hasHead ? (await git("diff", "HEAD")).out : wtStatus;
      const diffSnippet =
        diff.length > 6000 ? diff.slice(0, 6000) + "\n…(truncated)" : diff;
      const hint = args?.trim() ? `\nUser hint: ${args.trim()}\n` : "";

      // 1) Side-channel LLM call for commit message (not in main session).
      const message = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `yeet → ${ctx.model!.id}`,
          );
          loader.onAbort = () => done(null);
          (async () => {
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(
              ctx.model!,
            );
            if (!auth.ok || !auth.apiKey) {
              throw new Error(
                auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error,
              );
            }
            const res = await complete(
              ctx.model!,
              {
                systemPrompt: MSG_PROMPT,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: `${hint}Diffstat:\n${diffstat}\n\nDiff:\n${diffSnippet}`,
                      },
                    ],
                    timestamp: Date.now(),
                  } as never,
                ],
              },
              {
                apiKey: auth.apiKey,
                headers: auth.headers,
                signal: loader.signal,
              },
            );
            if (res.stopReason === "aborted") return null;
            return res.content
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text",
              )
              .map((c) => c.text)
              .join("\n")
              .trim();
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

      // Sanitize: strip wrapping quotes/backticks, leading "Subject:" labels.
      const cleanMessage = message
        .replace(/^\s*(?:subject:\s*)/i, "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();
      if (!cleanMessage) {
        ctx.ui.notify("/yeet: empty commit message", "error");
        return;
      }

      // 2) Stage + commit deterministically.
      const add = await git("add", "-A");
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

      // 3) Push.
      const push = await git("push");
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
