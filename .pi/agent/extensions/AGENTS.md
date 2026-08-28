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

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`web-search.ts`** — searches or fetches one or many web targets for external research, returning GitHub content as local context.
- **`eval/`** — runs persistent Python for iterative computation and bulk aggregation.
- **`lsp/`** — provides symbol navigation and deterministic post-edit diagnostics and fixes for code work.
- **`github-pr.ts`** — fetches concise PR metadata, failures, review threads, diffs, or a single section, for PR analysis.
- **`subagent.ts`** — delegates medium or large research, repository recon, or implementation while supporting background control and compact structured results.
- **`quiet-run.ts`** — runs a long or noisy shell command with its output kept in a log file, returning only the verdict and the requested slice.
- **`ask/`** — presents structured choices when a request needs clarification.

### Cleaner context

- **`btw.ts`** — answers quick side questions without adding them to main history.
- **`skill-packs.ts`** — enables Lark/Feishu or Google Workspace skills only when requested.
- **`folder-context.ts`** — loads scoped agent instructions when files are touched and refreshes them after edits.

### Workflow shortcuts

- **`go.ts`** — resumes an interrupted or stalled agent turn.
- **`yeet.ts`** — validates, generates Conventional Commits with Sonnet 4.6 or Codex fallback, and pushes current changes with progress.
- **`copy.ts`** — copies a selected code block or the session transcript.
- **`usage.ts`** — reports Claude Pro/Max and Codex/ChatGPT subscription usage and quota reset times on request.
- **`auto-rename.ts`** — gives established sessions descriptive names.

### Outside-pi surface

- **`notifier.ts`** — reports agent status through desktop and terminal surfaces when attention is elsewhere.
- **`tmux-bridge.ts`** — sends Nvim selections or diagnostics to Pi with line-accurate, size-bounded file context.

### TUI taste

- **`tui.ts`** — keeps the interface compact and exposes relevant session state.

## Layout

```
extensions/
├── tsconfig.json
├── node_modules → ../npm/node_modules
├── *.ts          single-file extensions
├── ask/          ask_user_question dialog
├── eval/         persistent Python
├── lsp/          navigation and post-edit feedback
└── shared/       shared extension utilities
```
