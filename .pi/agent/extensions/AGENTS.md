# my pi harness

<!-- AGENT: when you change any extension under `.pi/agent/extensions/`, update its bullet here so this README stays the source of truth. One bullet per extension: **`name`** — what it does and when to use it, in one concise clause. NO implementation detail (mechanism, internals, perf numbers, flag plumbing). Keep this file simple. -->

Personal agent harness built on top of [pi](https://github.com/earendil-works/pi). Each file here bends pi closer to how I want to drive an LLM: more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first — more code, less agent.** If a step can be a script, regex, or hard-coded branch, it's not a prompt. The LLM is the last resort.
2. **Protect the main agent's context.** History is the scarce resource. Anything that doesn't need to be remembered by the next turn shouldn't enter it — use side-channel completions, delegate recon to a subagent, keep bulk data in a kernel.
3. **Hooks idempotent.** Lifecycle events re-fire (`/new`, extension reload), so any hook with a repeatable side effect — spawns, widgets, queued work — must dedupe per session. Re-triggering is then free and silent.
4. **Agent borrows from my dev env, not the other way around.** My nvim config is the source of truth for LSP, formatters, diagnostics. The harness spawns a headless instance of _that_ nvim so the agent sees exactly what I see when editing — same servers, same rules. No agent-specific reimplementation of tooling I already maintain.
5. **Say _what_, not _how_ — everywhere.** Tool `description` / `promptSnippet` / `promptGuidelines` (the prompt the model reads) AND the bullets in this README describe capability and when to use it, never the implementation (no "headless nvim", "warm singleton", spawn/cache mechanics, perf numbers). Mechanism is noise; it lives in the code, not in prose.

How each rule is wired — which extension implements which mechanism — is described in the sections below.

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`eval/`** — persistent Python + JS kernels the model runs code in; cells can call pi's own tools and keep bulk data out of history. For "read N files, aggregate, summarize" work.
- **`lsp/`** — the LSP subsystem. Symbol-precise nav tools: `lsp_hover` (type/docs), `lsp_definition` / `lsp_type_definition` / `lsp_implementation`, `lsp_references`, `lsp_document_symbols` (file outline), `lsp_rename` (workspace-wide), `lsp_diagnostics` (on-demand, read-only per-file error/warning check instead of a full `tsc`). Also the post-edit feedback pass (`lsp/feedback/`): formats your edits and auto-fixes their diagnostics (root-cause, no suppress directives), surfacing the changes so you needn't re-read; anything left unfixed is flagged. `/lsp-fix on|off` toggles auto-fix per session; `/lsp-fix` alone runs it on demand over the last touched files.
- **`codegraph.ts`** — symbol-aware repo navigation + call-graph over the [codegraph CLI](https://github.com/colbymchenry/codegraph): `codegraph_status` / `_context` / `_search` / `_files` / `_callers` / `_callees` / `_impact` (blast-radius) / `_affected` (test selection).
- **`github-pr.ts`** — `github_pr` fetches a PR as signal-only markdown (metadata, description, changed files, failing checks, unresolved review threads — including bot inline findings like CodeRabbit). Drops commit/timeline noise, resolved threads, and bot release-note/walkthrough issue comments; diff is opt-in via `diff:true`. Use instead of `gh pr view`.
- **`subagent.ts`** — `/subagent` delegates a task to an isolated child `pi` process (single-layer, no recursion). Agents defined in `~/.pi/agent/agents/*.md`. For offloading research/recon/implementation off the main thread.
- **`worktree.ts`** — `worktree_create` / `worktree_list` / `worktree_publish` / `worktree_remove`: agent-driven git worktrees keyed by branch. Feature branches fork off the default branch and finish by pushing to origin for a PR — never merged into trunk locally.
- **`ask/`** — `ask_user_question`: presents a tabbed multiple-choice questionnaire (single/multi-select, free-text + "chat" fallbacks, review tab) instead of guessing when a request is ambiguous. Length limits on labels are soft so the first call always lands.

### Cleaner context

- **`btw.ts`** — `/btw <q>` asks a side question. For quick asides without polluting the main thread.
- **`folder-context.ts`** — injects a folder's `AGENTS.md` / `CLAUDE.md` / `README.md` when the agent touches a path in it; re-injects when the file is updated.

### Workflow shortcuts

- **`resend.ts`** — `/resend` re-runs the agent on the current transcript with nothing appended. For when you abort a prompt mid-stream or it stalls and auto-retry gives up: restarts inference on your message as-is, no duplicate.
- **`yeet.ts`** — `/yeet` stages, commits with an auto-written Conventional Commits message (informed by the recent conversation for intent), and pushes.
- **`copy.ts`** — `/copy-blocks` picks a fenced code block from the last assistant response; `/copy-all` copies the full session as markdown. Built-in `/copy` unchanged.
- **`auto-rename.ts`** — names the session after 3+ turns. Kills the default `2025-05-24T09-21-…` slugs.

### Outside-pi surface

- **`tmux-bridge.ts`** — push text or a file+prompt into the running session from another tmux pane or your editor.
- **`notifier.ts`** — desktop notification when a turn finishes and you're not looking at the pi pane.

### TUI taste

- **`tui.ts`** — visual tweaks: comfortable margins, coloured input line, compact footer, and the editor pinned to the bottom with autocomplete floating above it.
- **`code-blocks.ts`** — syntax-highlights fenced code blocks in assistant responses.

## Layout

```
extensions/
├── tsconfig.json
├── node_modules → ../npm/node_modules
├── *.ts          single-file extensions
├── ask/          ask_user_question questionnaire dialog
├── eval/         persistent kernels + bridge
├── lsp/          nvim singleton, nav tools + post-edit feedback
└── shared/       side-channel LLM helper, message extraction, widget factory, cross-extension config
```
