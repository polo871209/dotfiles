# my pi harness

<!-- AGENT: when adding, removing, or materially changing an extension under `.pi/agent/extensions/`, update its bullet here. One bullet per extension: capability and when to use it, in one concise clause. Omit implementation details. -->

Personal agent harness built on [pi](https://github.com/earendil-works/pi): more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first.** If a script, regex, or hard-coded branch can do the step, don't prompt an LLM.
2. **Protect main-agent context.** Keep data out of history unless the next turn needs it.
3. **Hooks idempotent.** Dedupe repeatable lifecycle side effects per session.
4. **Agent borrows from dev environment.** Nvim config remains the source of truth for LSP, formatters, and diagnostics; don't reimplement them for the agent.
5. **Say what, not how.** Model-facing descriptions and this capability index state capability and trigger, never mechanism.

## Working on pi itself

Before changing Pi-native behavior, read directly relevant documentation in the installed `@earendil-works/pi-coding-agent` package and its explicitly required prerequisites. Stop once the relevant API and constraints are covered.

Report a tool failure with a throw or `isError: true`. Pi ignores an `error` field on the result and shows the call as a success. A tool whose result is data declares `outputSchema` and returns `structuredContent`, because codemode scripts receive that value instead of the text.

Declare `annotations` on every tool: `readOnlyHint` and `openWorldHint` always, plus `destructiveHint` and `idempotentHint` when the tool writes. For a tool with several actions, annotate the worst action. Set `readOnlyHint` or `idempotentHint` only when a rerun after a crash or retry repeats no side effect.

Work that outlives its tool call, such as a background subagent run, writes a start entry and an end entry with `pi.appendEntry()`. On `session_start`, a start entry with no end entry means pi stopped mid-run, and the tool must report that run as interrupted instead of unknown.

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`web-search.ts`** — searches or fetches one or many web targets for external research, limits a search to chosen domains or a recent period, returns only the passages of a page that contain given text, ranks results most relevant first and drops the ones that do not answer the query, with a count of the dropped results, and returns GitHub links as local files or comment threads, videos as transcripts, and PDFs as text.
- **`lsp/`** — provides symbol navigation and deterministic post-edit diagnostics and fixes for code work.
- **`github-pr.ts`** — fetches concise PR metadata, failures, review threads, diffs, or a single section for PR analysis, and resolves all open review threads as soon as the review comments are fixed locally.
- **`subagent/`** — delegates external research, read-only recon of the local repo, or a read-only parallel review to an isolated agent, with background control, compact structured results, and an interrupted status for runs that a pi restart cut off.
- **`quiet-run.ts`** — runs shell commands by default, with output kept in a log file, returning only the verdict and the requested slice.
- **`ask/`** — presents structured choices when a request needs clarification, and shows the agent as waiting on the user in Rex while the dialog is open.

### Cleaner context

- **`skill-packs.ts`** — enables Lark/Feishu or Google Workspace skills only when requested.
- **`folder-context.ts`** — loads scoped agent instructions when files are touched and refreshes them after edits.
- **`btw.ts`** — answers a side question on `/btw` with the whole session as context, and keeps the exchange out of the main agent's context.

### Workflow shortcuts

- **`go.ts`** — resumes an interrupted or stalled agent turn.
- **`yeet.ts`** — validates, generates Conventional Commits with Sonnet 5.5, and pushes current changes with progress.
- **`worktree.ts`** — on `/wt` or when the user asks the agent for a worktree, moves the current session and tab into the git worktree of a branch under `.worktree/`, starts a separate agent on a task in a background worktree tab, lists worktrees with their changes and tabs, and removes a clean worktree with its tab while keeping its branch.
- **`fork-window.ts`** — on `/fork` or `/clone` in Rex, clones the whole current conversation into a new Rex window that takes focus, as a session named `fork: <name>` or `clone: <name>`, while this pane keeps the original session, so both run in parallel.
- **`runbook/`** — shows commands the user must run as steps that run inside pi with their output and exit status, paste into a Rex pane ready for Enter, or copy, from a click or the keyboard, hands a failed step's output to the agent, which can replace that step's command in place so the user continues from the same step, tells the agent on the next turn which steps ran and how they ended, with the output of failed steps and of steps whose log the user attaches, adds the same actions to code blocks, and copies a code block or the session transcript on request.
- **`usage.ts`** — reports Claude Pro/Max subscription usage and quota reset times on request.
- **`auto-rename.ts`** — titles each session in at most five words from its latest request, renames a fork or clone at its first new message, keeps a name the user set, and shows the title on the Rex tab.

### Outside-pi surface

- **`caffeinate.ts`** — keeps the Mac from idle sleep while the agent actively works, for at most 100 minutes per run, and lets the display sleep.
- **`posthog.ts`** — sends the model, tokens, cost, and latency of every model call, and the name, duration, and error flag of every tool call, to PostHog when `posthog.json` holds a project token, and never sends prompts, outputs, or tool arguments.
- **`rex-bridge.ts`** — sends Nvim selections or diagnostics from the same Rex session to Pi, and tells Nvim which file Pi edited last.

### TUI taste

- **`tui.ts`** — keeps the interface compact, exposes relevant session state, draws a Mermaid diagram that is wider than the terminal at a width that fits, and hands clicks on `pi-` links to other extensions.

## Layout

```
extensions/
├── tsconfig.json
├── node_modules → ../npm/node_modules
├── *.ts          single-file extensions
├── ask/          ask_user_question dialog
├── runbook/      command steps for the user, with Rex Lua
├── lsp/          navigation and post-edit feedback
├── subagent/     isolated agents in Rex panes
└── shared/       shared extension utilities
```
