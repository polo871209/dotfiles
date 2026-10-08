import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { sideChannelWithLoader } from "./shared/llm";

const MAX_BODY_LINES = 2;

function barWidget(lines: string[]) {
  return (_tui: unknown, theme: Theme) => {
    const container = new Container();
    const build = () => {
      container.clear();
      lines.forEach((line, i) => {
        const color = i === 0 ? "customMessageLabel" : "customMessageText";
        container.addChild(new Text(theme.fg(color, `▎ ${line}`), 1, 0));
      });
    };
    build();
    const invalidate = container.invalidate.bind(container);
    container.invalidate = () => {
      build();
      invalidate();
    };
    return container;
  };
}

const MSG_PROMPT = `
Write a tiny Conventional Commits message for the diff. The code is the source of truth and the reader has it, so the message names the change and never describes the code.

## Input authority
The diff alone decides WHAT changed. A \`User hint:\` line, when present, carries intent: it can pick which change leads, set the scope, or give the WHY. Never let it add, rename, or overstate a change the diff does not contain, and ignore any part that points at something absent from the diff.

## Rank the changes first
Before writing, decide which single change a reader cares about. A user hint that names a priority wins: the change it points to is top-ranked, even when another hunk looks larger. Otherwise rank hunks by impact: behavior change beats new capability beats refactor beats rename, formatting, comment, import, version bump, or generated file. Diff size and file order do not decide rank; a one-line behavior change outranks a 300-line mechanical edit. The top-ranked change owns the subject, and the rest stay out of the message unless they break something.

## Subject
Format: \`<type>(<scope>): <subject>\` where type ∈ {feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}; scope is optional. Never write the \`!\` breaking-change marker. State the top-ranked change, never a side detail and never a vague umbrella such as \`update files\` or \`various fixes\`. Use imperative mood (\`add\`, \`fix\` — not \`added\`, \`adds\`), lowercase, ≤50 chars when possible (hard cap 72), no trailing period, and do not restate a file name already named by the scope.

Match the type and scope vocabulary of the recent commit subjects, and reuse an existing scope for the same area.

## Body
Default: subject only. Add a body only when the WHY is invisible in the diff, for example an external constraint, the cause of a bug, or the impact of an incompatible change. Hard cap: ${MAX_BODY_LINES} \`-\` bullet lines, each under 72 chars, after one blank line. Lines past the cap are dropped. Never list files, functions, or side changes, and never narrate what the code does. If a line repeats something the diff shows, delete it.

## Forbidden output
No breaking-change marker in any form: no \`!\` before the colon, no \`BREAKING CHANGE\` footer, no \`breaking\` in the subject. No footers. No preamble, reasoning, or fences, and do not begin with "Looking at the diff, I need to understand...". Do not write \`this commit\`, \`I\`, \`we\`, \`now\`, \`currently\`, \`as requested by\`, emoji, or AI attribution.

Return the raw commit message, starting with the subject line.`;

const YEET_MSG_TYPE = "yeet-marker";
const YEET_WIDGET_KEY = "yeet-progress";
const PUSH_TIMEOUT_MS = 120_000;
const HOOK_TIMEOUT_MS = 600_000;

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

  const commitAndPush = async (
    args: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/yeet requires interactive mode", "error");
      return;
    }
    const yeetModel = ctx.modelRegistry.find("anthropic", "claude-sonnet-5-5");
    if (!yeetModel || !ctx.modelRegistry.hasConfiguredAuth(yeetModel)) {
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
    const showProgress = (active: number) => {
      ctx.ui.setWidget(
        YEET_WIDGET_KEY,
        barWidget([
          "yeet",
          ...steps.map((step, index) =>
            index < active
              ? `✓ ${step}`
              : index === active
                ? `→ ${step}`
                : `○ ${step}`,
          ),
        ]),
        { placement: "aboveEditor" },
      );
    };

    const IGNORED_PATHS = ["git/"];
    const EXCLUDE = IGNORED_PATHS.map((p) => `:(exclude,top)${p}`);

    const gitWith = async (timeout: number | undefined, gargs: string[]) => {
      const r = await pi.exec("git", ["-c", "color.ui=never", ...gargs], {
        cwd,
        timeout,
      });
      return {
        // pi.exec reports a signal-killed child (timeout) as code 0.
        ok: r.code === 0 && !r.killed,
        out: r.stdout.trim(),
        err: r.stderr.trim(),
        stdout: r.stdout,
        stderr: r.stderr || (r.killed ? `timed out after ${timeout}ms` : ""),
      };
    };
    const git = (...gargs: string[]) => gitWith(undefined, gargs);
    const gitPush = (...gargs: string[]) =>
      gitWith(PUSH_TIMEOUT_MS, ["push", ...gargs]);

    const pushAndReport = async (sha: string, subject: string) => {
      showProgress(4);
      let push = await gitPush();
      if (!push.ok && /no upstream branch|--set-upstream/i.test(push.stderr)) {
        push = await gitPush("-u", "origin", "HEAD");
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

      pi.sendMessage(
        {
          customType: YEET_MSG_TYPE,
          content: `${sha} ${subject} (${pushNote})`,
          display: true,
        },
        { triggerTurn: false },
      );
    };

    if (!(await git("rev-parse", "--git-dir")).ok) {
      ctx.ui.notify("/yeet: not a git repository", "error");
      return;
    }

    const hasHead = (await git("rev-parse", "--verify", "HEAD")).ok;
    const wtStatus = (await git("status", "--porcelain", "--", ".", ...EXCLUDE))
      .out;
    if (!wtStatus) {
      const ahead = await git("rev-list", "--count", "@{upstream}..HEAD");
      if (ahead.ok && Number(ahead.out) > 0) {
        const sha = (await git("rev-parse", "--short", "HEAD")).out;
        const subject = (await git("log", "-1", "--format=%s")).out;
        const n = Number(ahead.out);
        await pushAndReport(
          sha,
          n > 1 ? `${subject} and ${n - 1} earlier commit(s)` : subject,
        );
        return;
      }
      ctx.ui.notify("/yeet: nothing to commit", "warning");
      return;
    }

    showProgress(0);
    const add = await git("add", "-A", "--", ".", ...EXCLUDE);
    if (!add.ok) {
      ctx.ui.notify(`/yeet: git add failed: ${add.err}`, "error");
      return;
    }

    showProgress(1);
    let hook = await gitWith(HOOK_TIMEOUT_MS, [
      "hook",
      "run",
      "--ignore-missing",
      "pre-commit",
    ]);
    const unstaged = await git("diff", "--quiet", "--", ".", ...EXCLUDE);
    if (!unstaged.ok) {
      const restage = await git("add", "-A", "--", ".", ...EXCLUDE);
      if (!restage.ok) {
        ctx.ui.notify(`/yeet: git add failed: ${restage.err}`, "error");
        return;
      }
      hook = await gitWith(HOOK_TIMEOUT_MS, [
        "hook",
        "run",
        "--ignore-missing",
        "pre-commit",
      ]);
    }
    if (!hook.ok) {
      const detail = [hook.stdout, hook.stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify("/yeet: pre-commit failed (see history)", "error");
      pi.sendMessage(
        {
          customType: YEET_MSG_TYPE,
          content: `pre-commit failed:\n${detail || "(no output)"}`,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }

    const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const base = hasHead ? "HEAD" : emptyTreeSha;
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

    const log = await git("log", "-10", "--no-merges", "--format=%s");
    const historyBlock =
      log.ok && log.out
        ? `Recent commit subjects (style reference):\n${log.out}\n\n`
        : "";

    const branch = (await git("symbolic-ref", "--quiet", "--short", "HEAD"))
      .out;
    const branchBlock = branch ? `Current branch: ${branch}\n\n` : "";

    showProgress(2);
    const message = await sideChannelWithLoader(ctx, `yeet → ${yeetModel.id}`, {
      systemPrompt: MSG_PROMPT,
      model: yeetModel,
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
    });

    if (!message) {
      ctx.ui.notify("/yeet cancelled", "info");
      return;
    }

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
    const [subject = "", ...bodyLines] = trimmedMessage
      .replace(/^\s*(?:subject|title|commit(?:\s*message)?|message):\s*/i, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim()
      .split("\n");
    const body = bodyLines
      .filter((line) => line.trim())
      .slice(0, MAX_BODY_LINES);
    const cleanMessage = body.length
      ? [subject, "", ...body].join("\n")
      : subject;
    if (!cleanMessage) {
      ctx.ui.notify("/yeet: empty commit message", "error");
      return;
    }

    showProgress(3);
    const commit = await git("commit", "--no-verify", "-m", cleanMessage);
    if (!commit.ok) {
      const detail = [commit.stdout, commit.stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
      ctx.ui.notify("/yeet: commit failed (see history)", "error");
      pi.sendMessage(
        {
          customType: YEET_MSG_TYPE,
          content: `commit failed:\n${detail || "(no output)"}`,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }
    const sha = (await git("rev-parse", "--short", "HEAD")).out;

    await pushAndReport(sha, subject);
  };

  const runYeet = async (args: string, ctx: ExtensionContext) => {
    try {
      await commitAndPush(args, ctx);
    } finally {
      ctx.ui.setWidget(YEET_WIDGET_KEY, undefined);
    }
  };

  pi.registerCommand("yeet", {
    description:
      "Stage, commit, and push current repo changes; args are a hint for the commit message",
    handler: runYeet,
  });

  pi.registerShortcut("ctrl+alt+y", {
    description: "Stage, commit, and push current repo changes",
    handler: (ctx) => runYeet("", ctx),
  });
}
