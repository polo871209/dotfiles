# my pi harness

<!-- AGENT: when you add, remove, or materially change an extension here, update its bullet below. One bullet per extension: what it does and when it applies, in one clause. No mechanism. -->

Personal agent harness on [pi](https://github.com/earendil-works/pi): more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first.** If a script, regex, or fixed branch can do the step, do not prompt an LLM.
2. **Protect main-agent context.** Keep data out of history unless the next turn needs it.
3. **Idempotent hooks.** Dedupe repeatable lifecycle side effects per session.
4. **Borrow the dev environment.** The Nvim configuration owns LSP, formatters, and diagnostics. Reuse it instead of reimplementing it.
5. **Say what, not how.** Model-facing descriptions and this index state capability and trigger, never mechanism.

## Working on pi itself

Before you change pi-native behavior, read the relevant docs in the installed `@earendil-works/pi-coding-agent` package. Stop when the API and its constraints are covered.

- Report a tool failure with a throw or `isError: true`. Pi ignores an `error` field and shows the call as a success.
- A tool that returns data declares `outputSchema` and returns `structuredContent`, because codemode scripts receive that value instead of the text.
- Every tool declares `annotations`: `readOnlyHint` and `openWorldHint` always, plus `destructiveHint` and `idempotentHint` when it writes. Annotate the worst action of a multi-action tool. Set `readOnlyHint` or `idempotentHint` only if a rerun after a crash repeats no side effect.
- Work that outlives its tool call, such as a background subagent run, writes a start entry and an end entry with `pi.appendEntry()`. On `session_start`, a start entry without an end entry means pi stopped mid-run, so report that run as interrupted.

## What it adds to vanilla pi

### Tools for the model

- **`web-search.ts`** — searches or fetches web targets for external research, scoped by domain or recency, ranked and filtered for relevance, and returns GitHub links as local files or threads, videos as transcripts, and PDFs as text.
- **`lsp/`** — symbol navigation, plus deterministic post-edit diagnostics and fixes.
- **`github-pr.ts`** — fetches a PR's metadata, failing checks, review bodies and threads, or diff, and once the comments are fixed locally, resolves open threads and hides review content that no longer holds.
- **`subagent/`** — delegates external research, read-only repo recon, or parallel review to an isolated agent. It runs in the foreground or background, returns compact structured results, shows each run's live status in pi without Rex status or notifications, and delivers background results as a message.
- **`quiet-run.ts`** — the default way to run shell commands. Output goes to a log, and the agent gets the verdict and the requested slice.
- **`ask/`** — structured choices when a request needs clarification.

### Cleaner context

- **`skill-packs.ts`** — enables Lark/Feishu or Google Workspace skills only on request, for one session or as a repository default.
- **`poteto/`** — on `/poteto`, switches the current session into pstack's poteto mode with the latest pstack skills, and switches it back off on the next `/poteto`. `/poteto repo` flips the default for every new session in the repository.
- **`folder-context.ts`** — loads scoped agent instructions when files are touched, and refreshes them after edits.
- **`btw.ts`** — answers a `/btw` side question with the session as context, outside the main agent's history.

### Workflow shortcuts

- **`go.ts`** — resumes an interrupted or stalled agent turn.
- **`yeet.ts`** — validates, writes Conventional Commits, and pushes current changes.
- **`worktree.ts`** — on `/wt` or a worktree request, moves the session into a branch's worktree under `.worktree/`, starts a background agent in a new worktree, lists worktrees, and removes clean ones.
- **`fork-window.ts`** — on `/fork` or `/clone` in Rex, continues the conversation in a new Rex window while this pane keeps the original.
- **`runbook/`** — shows commands the user must run as steps they can run in pi, paste into a Rex pane, or copy. It hands failed output back to the agent for a fix in place, and reports on the next turn which steps ran and how they ended.
- **`usage.ts`** — reports Claude Pro/Max usage and quota reset times.
- **`auto-rename.ts`** — titles each session from its requests, weighted toward the latest one, and shows the title on the Rex tab. A name the user set is kept.

### Outside pi

- **`approval.ts`** — asks the user before a risky shell command runs, such as `kill`, `pkill`, or `killall`, and makes subagents hand those commands back to the parent agent.
- **`caffeinate.ts`** — keeps the Mac awake while the agent works, for at most 100 minutes per run.
- **`posthog.ts`** — sends model, token, cost, latency, and tool-call metrics to PostHog when `posthog.json` holds a token. It never sends prompts, outputs, or tool arguments.
- **`rex-bridge.ts`** — sends Nvim selections or diagnostics from the same Rex session to pi, and tells Nvim which file pi edited last.

### TUI

- **`tui.ts`** — compact interface with session state, Mermaid diagrams fitted to the terminal width, and clicks on `pi-` links routed to other extensions.

## Layout

Single-file extensions sit at the top level. Each directory is one extension, except `shared/`, which holds utilities used by several. `node_modules` links to `../npm/node_modules`.
