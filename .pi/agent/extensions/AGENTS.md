# my pi harness

<!-- AGENT: when you change any extension under `.pi/agent/extensions/`, update its bullet here so this README stays the source of truth. One bullet per extension: **`name`** — what it does and when to use it, in one concise clause. NO implementation detail (mechanism, internals, perf numbers, flag plumbing). Keep this file simple. -->

Personal agent harness built on top of [pi](https://github.com/earendil-works/pi). Each file here bends pi closer to how I want to drive an LLM: more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first — more code, less agent.** If a step can be a script, regex, or hard-coded branch, it's not a prompt. The LLM is the last resort.
2. **Protect the main agent's context.** History is the scarce resource. Anything that doesn't need to be remembered by the next turn shouldn't enter it — use side-channel completions, delegate recon to a subagent, keep bulk data in a kernel. When authoring an extension, custom tool, or skill, read the `writing-skills` skill first (`~/.pi/skills/writing-skills/SKILL.md`) for token-lean output design.
3. **Hooks idempotent.** Lifecycle events re-fire (`/new`, extension reload), so any hook with a repeatable side effect — spawns, widgets, queued work — must dedupe per session. Re-triggering is then free and silent.
4. **Agent borrows from my dev env, not the other way around.** My nvim config is the source of truth for LSP, formatters, diagnostics. The harness spawns a headless instance of _that_ nvim so the agent sees exactly what I see when editing — same servers, same rules. No agent-specific reimplementation of tooling I already maintain.
5. **Say _what_, not _how_ — everywhere.** Tool `description` / `promptSnippet` / `promptGuidelines` (the prompt the model reads) AND the bullets in this README describe capability and when to use it, never the implementation (no "headless nvim", "warm singleton", spawn/cache mechanics, perf numbers). Mechanism is noise; it lives in the code, not in prose.

How each rule is wired — which extension implements which mechanism — is described in the sections below.

## Working on pi itself

When building or modifying anything pi-native (extensions, custom tools, etc), read pi's own docs **before** implementing — they ship with the installed package, not in this repo:

- README: `~/.local/share/mise/installs/npm-earendil-works-pi-coding-agent/latest/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- docs/: `.../pi-coding-agent/docs/` — `extensions.md`, `skills.md`, `tui.md`, `keybindings.md`, `sdk.md`, `custom-provider.md`, `models.md`, `packages.md`, `prompt-templates.md`, `themes.md`, `compaction.md`, `json.md`
- examples/: `.../pi-coding-agent/examples/` — `extensions/`, `sdk/`, custom tools

Read referenced `.md` files completely and follow their cross-references before writing code.

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`web-search.ts`** — `web_search` / `fetch_content`: search the web and pull a page's readable content as markdown, for basic research without leaving the terminal. GitHub repo/file/dir links are cloned locally instead of scraped, so `read`/`bash` can explore real files.
- **`eval/`** — persistent Python + JS kernels the model runs code in; cells can call pi's own tools and keep bulk data out of history. For "read N files, aggregate, summarize" work.
- **`lsp/`** — the LSP subsystem. Symbol-precise nav tools: `lsp_hover` (type/docs), `lsp_definition` / `lsp_type_definition` / `lsp_implementation`, `lsp_references`, `lsp_document_symbols` (file outline), `lsp_rename` (workspace-wide), `lsp_diagnostics` (on-demand, read-only per-file error/warning check instead of a full `tsc`). Also the post-edit feedback pass (`lsp/feedback/`): formats your edits and auto-fixes their diagnostics in the background (root-cause, no suppress directives, never touching files unrelated to a diagnostic), surfacing the changes so you needn't re-read; anything left unfixed is flagged. `/lsp-fix` toggles that background auto-fix per session (`/lsp-fix on|off` to set explicitly); launch with `--lsp-fix=false` to default it off.
- **`codegraph.ts`** — symbol-aware repo navigation + call-graph over the [codegraph CLI](https://github.com/colbymchenry/codegraph): `codegraph_status` / `_context` / `_search` / `_files` / `_callers` / `_callees` / `_impact` (blast-radius) / `_affected` (test selection).
- **`github-pr.ts`** — `github_pr` fetches a PR as signal-only markdown (metadata, description, changed files, failing checks, unresolved review threads — including bot inline findings like CodeRabbit). Drops commit/timeline noise, resolved threads, and bot release-note/walkthrough issue comments; diff is opt-in via `diff:true`. Use instead of `gh pr view`.
- **`subagent.ts`** — `/subagent` delegates a task to an isolated `pi` agent (single-layer, no recursion), running visibly in its own herdr pane instead of a hidden background process — watch, scroll, or step in directly. Agents defined in `~/.pi/agent/agents/*.md` — each file's body is the subagent's entire system prompt, no shared preamble or other context added, for an unambiguous clean start. For offloading research/recon/implementation off the main thread. Herdr-only: the tool isn't available outside a herdr session.
- **`worktree.ts`** — `worktree_create` / `worktree_list` / `worktree_publish` / `worktree_remove`: agent-driven git worktrees keyed by branch, each opened as its own herdr workspace with a live agent pane you can hand work off to and drive directly. Feature branches fork off the default branch and finish by pushing to origin for a PR — never merged into trunk locally. Herdr-only.
- **`ask/`** — `ask_user_question`: presents a tabbed multiple-choice questionnaire (single/multi-select, free-text + "chat" fallbacks, review tab) instead of guessing when a request is ambiguous. Length limits on labels are soft so the first call always lands.

### Cleaner context

- **`btw.ts`** — `/btw <q>` asks a side question. For quick asides without polluting the main thread.
- **`folder-context.ts`** — injects a folder's `AGENTS.md` / `CLAUDE.md` when the agent touches a path in it; re-injects when the file is updated. Main session only — subagents get a clean context (just their agent `.md` + tools), no ambient repo docs.

### Workflow shortcuts

- **`resend.ts`** — `/resend` re-runs the agent on the current transcript with nothing appended. For when you abort a prompt mid-stream or it stalls and auto-retry gives up: restarts inference on your message as-is, no duplicate.
- **`gate.ts`** — `/gate [intent]` spins out a background agent that validates the current branch (intent → rebase → review → lsp diagnostics → test → comment-cleanup → lint, auto-fixing safe issues) and, on a clean verdict, lands the gated result back onto the branch once it's no longer checked out — your checkout stays free to keep working or switch branches meanwhile.
- **`yeet.ts`** — `/yeet` stages, commits with an auto-written Conventional Commits message (informed by recent user input for intent, not agent responses), and pushes.
- **`copy.ts`** — `/copy-blocks` picks a fenced code block from the last assistant response; `/copy-all` copies the full session as markdown. Built-in `/copy` unchanged.
- **`auto-rename.ts`** — names the session after 3+ turns. Kills the default `2025-05-24T09-21-…` slugs.

### TUI taste

- **`tui.ts`** — visual tweaks: coloured input line, compact footer, input pinned to the bottom of the viewport, and autocomplete floating as an overlay above the editor.
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
└── shared/       side-channel LLM helper, message extraction, widget factory
```
