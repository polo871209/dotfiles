# my pi harness

<!-- AGENT: when you change any extension under `.pi/agent/extensions/`, update its bullet here so this README stays the source of truth. Keep the bullet style consistent: **`name`** — capability lead clause, then trimmed mechanism. Concise; no redundant phrasing. -->

Personal agent harness built on top of [pi](https://github.com/earendil-works/pi). Each file here bends pi closer to how I want to drive an LLM: more tools, less context bloat, fewer reasons to leave the terminal.

## Design rules

1. **Deterministic first — more code, less agent.** If a step can be a script, regex, or hard-coded branch, it's not a prompt. The LLM is the last resort.
2. **Protect the main agent's context.** History is the scarce resource. Anything that doesn't need to be remembered by the next turn shouldn't enter it — use side-channel completions, delegate recon to a subagent, keep bulk data in a kernel.
3. **Precise discovery beats grep.** Prefer symbol-aware navigation (real LSP, indexed code graph) over text search. Typed queries return fewer false positives and skip the read-to-confirm round trip.
4. **Hooks idempotent.** Lifecycle hooks dedupe per session so re-triggering is free and silent.
5. **Agent borrows from my dev env, not the other way around.** My nvim config is the source of truth for LSP, formatters, diagnostics. The harness spawns a headless instance of _that_ nvim so the agent sees exactly what I see when editing — same servers, same rules. No agent-specific reimplementation of tooling I already maintain.

How each rule is wired — which extension implements which mechanism — is described in the sections below.

## What it adds to vanilla pi

### Bigger toolbox for the model

- **`eval/`** — persistent Python + JS kernels the model runs code in. A loopback bridge lets cells call pi's own tools (`tool.read`, `tool.bash`, …); data lives in kernel RAM, not history — 10–100× token savings on "read 50 files, summarize" tasks. Docs in `eval/README.md`.
- **`lsp/`** — real LSP navigation + refactor via a headless nvim singleton: `lsp_hover` / `lsp_definition` / `lsp_references` / `lsp_rename`. `lsp_rename` runs a workspace-wide `textDocument/rename` — applies the WorkspaceEdit, writes every changed file, invalidates the nav cache. Symbol-precise, not grep theater.
- **`codegraph.ts`** — symbol-aware repo navigation + call-graph over the [codegraph CLI](https://github.com/colbymchenry/codegraph): `codegraph_status` / `_context` / `_search` / `_files` / `_callers` / `_callees` / `_impact` / `_affected` (blast-radius via `impact`, test selection via `affected`). Registers only if the cwd has an index (`codegraph init`, then restart pi); fires `codegraph sync -q` after every edit turn so CLI reads don't hit a stale graph.
- **`subagent.ts`** — `/subagent` delegates a task to a child `pi` process (`--mode json -p`, live TUI). Single-layer (no recursion). Agents live in `~/.pi/agent/agents/*.md` with YAML frontmatter. Resolves on the child's `close`; a post-exit stdio guard destroys grandchild-held (nvim/kernel) pipes after an idle/hard timeout so `close` always fires (no hang). On a clean terminal `stop` it grace-then-`SIGTERM`→`SIGKILL`s a lingering child and classifies that self-issued kill as success (not a bogus "killed by SIGTERM, parent aborted"); only an `AbortSignal` is reported as a parent abort.

### Cleaner context

- **`btw.ts`** — `/btw <q>` asks a side-channel question; Q + A never enter session history. For "wait why did that fail" without polluting the main thread.
- **`folder-context.ts`** — injects a folder's `AGENTS.md` / `CLAUDE.md` / `README.md` once, the first time the agent touches a file in it. Per-folder context loads itself.
- **`lsp-feedback.ts`** (+ `lsp-feedback.lua`) — after every edit, routes the file through nvim for format + safe code-actions + diagnostics; errors/warnings drive an LLM auto-fix loop (fix root cause, no ignore/disable directives), leftovers fire a `notify` for manual review. Per-edit lint uses a fast-linter allowlist — `SLOW_LINTERS` (e.g. semgrep) are skipped (async results land after the file budget returns; SAST belongs at pre-commit/CI). The `vim.g.pi_agent` flag (set pre-config via `--cmd`) makes cosmetic plugins early-return and `plugin/lint.lua` skip slow linters, loading only LSP/format/lint — ~40% faster start, identical rules, interactive nvim unaffected. On `session_start` the nvim warm-spawns + preloads the feedback lua via deferred `setTimeout(0)` (off pi's critical path) so the first edit skips spawn/init/attach latency.

### Workflow shortcuts

- **`yeet.ts`** — `/yeet` stages, commits (LLM writes the Conventional Commits msg), and pushes. Side-channel msg gen — doesn't pollute history.
- **`copy.ts`** — `/copy-blocks` picks a fenced code block from the last assistant response; `/copy-all` copies the full session as markdown. Built-in `/copy` unchanged.
- **`auto-rename.ts`** — names the session after 3+ turns via a stateless LLM call. Kills the default `2025-05-24T09-21-…` slugs.

### Outside-pi surface

- **`tmux-bridge.ts`** — Unix socket (`$TMPDIR/pi-tmux-<id>/bridge.sock`) for cross-pane push into the running session. Accepts `{"text"}` (plain) or `{"prompt", "file":{path,sline,eline,ft,content}}` — the latter sends the prompt as the user message and queues the file as an `nvim-file` message (`deliverAs:"nextTurn"`) injected just below it, rendered as one compact `path (L…, N lines)` line so history stays small while the LLM gets full content (no read round-trip). Clients: `tmux/pi-send` (shell CLI, `{"text"}` JSON lines) and `nvim/lua/pi.lua` (`<leader><leader>` sends buffer + prompt + range, falling back to a `{"text"}` ref for buffers >200KB under the 256KB socket cap; `<leader>da` sends buffer diagnostics; probes macOS `DARWIN_USER_TEMP_DIR` since nvim's `$TMPDIR` differs from Node's).
- **`notifier.ts`** — desktop notification when pi finishes a turn and the tmux pane isn't focused. ghostty OSC 777 over a tmux DCS passthrough (`allow-passthrough on`); if the pi pane is hidden it's written to a visible pane's `#{pane_tty}` so it still reaches the ghostty surface. Window title (OSC 0, ~300ms settle) carries the project name as subtitle → `pi` / `<project>` / `<message>`. Falls back to `osascript` with no ghostty target. Caveat: ghostty mutes its own banner while focused (different tmux window = sound only) — by design.

### TUI taste

- **`tui.ts`** — left/right padding, input-line color, slim footer, editor pinned to the viewport bottom (filler blanks above shrink as the conversation grows), and autocomplete rendered as a floating overlay above the editor (covers conversation lines, restores on close).
- **`code-bat.ts`** — renders markdown code blocks through `bat` for syntax highlight. First render ~50ms, memoized after.

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
