# my pi harness

<!-- AGENT: when you change any extension under `.pi/agent/extensions/`, update its bullet here so this README stays the source of truth. One bullet per extension: **`name`** — what it does and when to use it, in one concise clause. NO implementation detail (mechanism, internals, perf numbers, flag plumbing). Keep this file simple. -->

Personal agent harness built on top of [pi](https://github.com/earendil-works/pi). Each file here bends pi closer to how I want to drive an LLM: more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first — more code, less agent.** If a step can be a script, regex, or hard-coded branch, it's not a prompt. The LLM is the last resort.
2. **Protect the main agent's context.** History is the scarce resource. Anything that doesn't need to be remembered by the next turn shouldn't enter it — use side-channel completions, delegate recon to a subagent, keep bulk data in a kernel.
3. **Precise discovery beats grep.** Prefer symbol-aware navigation (real LSP, indexed code graph) over text search. Typed queries return fewer false positives and skip the read-to-confirm round trip.
4. **Hooks idempotent.** Lifecycle hooks dedupe per session so re-triggering is free and silent.
5. **Agent borrows from my dev env, not the other way around.** My nvim config is the source of truth for LSP, formatters, diagnostics. The harness spawns a headless instance of _that_ nvim so the agent sees exactly what I see when editing — same servers, same rules. No agent-specific reimplementation of tooling I already maintain.
6. **Say _what_, not _how_ — everywhere.** Tool `description` / `promptSnippet` / `promptGuidelines` (the prompt the model reads) AND the bullets in this README describe capability and when to use it, never the implementation (no "headless nvim", "warm singleton", spawn/cache mechanics, perf numbers). Mechanism is noise; it lives in the code, not in prose.

How each rule is wired — which extension implements which mechanism — is described in the sections below.

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`eval/`** — persistent Python + JS kernels the model runs code in; cells can call pi's own tools and keep bulk data out of history. For "read N files, aggregate, summarize" work.
- **`lsp/`** — symbol-precise LSP tools: `lsp_hover` (type/docs), `lsp_definition` / `lsp_type_definition` / `lsp_implementation`, `lsp_references`, `lsp_document_symbols` (file outline), `lsp_rename` (workspace-wide), `lsp_diagnostics` (on-demand, read-only per-file error/warning check instead of a full `tsc`).
- **`codegraph.ts`** — symbol-aware repo navigation + call-graph over the [codegraph CLI](https://github.com/colbymchenry/codegraph): `codegraph_status` / `_context` / `_search` / `_files` / `_callers` / `_callees` / `_impact` (blast-radius) / `_affected` (test selection). Registers only if the cwd has a codegraph index.
- **`github-pr.ts`** — `github_pr` fetches a PR as signal-only markdown (metadata, description, changed files, failing checks, unresolved review threads — including bot inline findings like CodeRabbit). Drops commit/timeline noise, resolved threads, and bot release-note/walkthrough issue comments; diff is opt-in via `diff:true`. Use instead of `gh pr view`.
- **`subagent.ts`** — `/subagent` delegates a task to an isolated child `pi` process (single-layer, no recursion). Agents defined in `~/.pi/agent/agents/*.md`. For offloading research/recon/implementation off the main thread.
- **`worktree.ts`** — `worktree_create` / `worktree_list` / `worktree_publish` / `worktree_remove`: agent-driven git worktrees keyed by branch. Feature branches fork off the default branch and finish by pushing to origin for a PR — never merged into trunk locally. Registers only when the `wt` binary is present.

### Cleaner context

- **`btw.ts`** — `/btw <q>` asks a side-channel question; Q + A never enter session history. For quick asides without polluting the main thread.
- **`folder-context.ts`** — injects a folder's `AGENTS.md` / `CLAUDE.md` / `README.md` when the agent touches a path in it; re-injects if the file changes on disk.
- **`lsp-feedback.ts`** (+ `lsp-feedback.lua`) — after every edit, formats the file and auto-fixes its diagnostics via an LLM loop (root-cause, no ignore directives); leftovers fire a `notify` for manual review. `/lsp-fix on|off` toggles auto-fix per session; `/lsp-fix` alone runs it on demand over the last touched files.

### Workflow shortcuts

- **`yeet.ts`** — `/yeet` stages, commits (LLM writes the Conventional Commits msg, informed by the recent conversation for intent), and pushes. Side-channel msg gen — doesn't pollute history.
- **`copy.ts`** — `/copy-blocks` picks a fenced code block from the last assistant response; `/copy-all` copies the full session as markdown. Built-in `/copy` unchanged.
- **`auto-rename.ts`** — names the session after 3+ turns via a stateless LLM call. Kills the default `2025-05-24T09-21-…` slugs.

### Outside-pi surface

- **`tmux-bridge.ts`** — push text or a file+prompt into the running session from another tmux pane. Clients: `tmux/pi-send` (CLI) and `nvim/lua/pi.lua` (`<leader><leader>` sends buffer+range, `<leader>da` sends diagnostics).
- **`notifier.ts`** — desktop notification when pi finishes a turn and its tmux pane isn't focused.

### TUI taste

- **`tui.ts`** — layout tweaks: padding, input-line color, slim footer, bottom-pinned editor, floating autocomplete overlay.
- **`code-bat.ts`** — renders markdown code blocks through `bat` for syntax highlight.

## Layout

```
extensions/
├── tsconfig.json
├── node_modules → ../npm/node_modules
├── *.ts          single-file extensions
├── eval/         persistent kernels + bridge
├── lsp/          headless nvim singleton + nav tools
└── shared/       side-channel LLM helper, message extraction, widget factory
```
