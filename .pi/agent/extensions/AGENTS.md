# my pi harness

<!-- AGENT: when you change any extension under `.pi/agent/extensions/`, update its bullet here so this README stays the source of truth. -->

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

- **`eval/`** — persistent Python + JS kernels with a loopback bridge so cells can call pi's own tools (`tool.read`, `tool.bash`, …). Data lives in kernel RAM, not conversation history. 10–100× token savings on "read 50 files, summarize" shape tasks. Full docs in `eval/README.md`.
- **`lsp/`** — headless nvim singleton exposes `lsp_hover` / `lsp_definition` / `lsp_references`. Real LSP, not grep theater.
- **`codegraph.ts`** — wraps [codegraph CLI](https://github.com/colbymchenry/codegraph) as `codegraph_status` / `_context` / `_search` / `_files`. Symbol-aware repo navigation. Probes `codegraph status` at load; tools register only if the cwd has an index (run `codegraph init -i` then restart pi).
- **`subagent.ts`** — `/subagent` delegates to a child `pi` process. Single-layer (no recursion). Agents live in `~/.pi/agent/agents/*.md` with YAML frontmatter.

### Cleaner context

- **`btw.ts`** — `/btw <q>` side-channel question. Q + A never enter session history. For "wait why did that fail" without polluting the main thread.
- **`folder-context.ts`** — first time agent touches a file, inject that folder's `AGENTS.md` / `CLAUDE.md` / `README.md` once. Per-folder context loads itself.
- **`lsp-feedback.ts`** (+ sibling `lsp-feedback.lua`) — after every edit, route file through nvim for format + safe code-actions + diagnostics. Errors and warnings trigger an LLM auto-fix loop.

### Workflow shortcuts

- **`yeet.ts`** — `/yeet` stages, commits (LLM writes Conventional Commits msg), pushes. Side-channel msg gen — doesn't pollute history.
- **`copy.ts`** — `/copy-blocks` picker over fenced code blocks in last assistant response; `/copy-all` copies full session as markdown. Built-in `/copy` unchanged.
- **`auto-rename.ts`** — after 3+ turns, stateless LLM call picks a short session name. Kills the default `2025-05-24T09-21-…` slugs.

### Outside-pi surface

- **`tmux-bridge.ts`** — Unix socket at `$TMPDIR/pi-tmux-<id>/bridge.sock` for cross-pane push into the running session. Two clients in this dotfiles:
  - `tmux/pi-send` — shell CLI, writes `{"text": "..."}` JSON lines.
  - `nvim/lua/pi.lua` — `<leader><leader>` (visual) sends selection + prompt; `<leader>da` (normal) sends current buffer diagnostics. Probes macOS `DARWIN_USER_TEMP_DIR` since nvim's `$TMPDIR` differs from Node's `os.tmpdir()`.
- **`notifier.ts`** — macOS notification when pi finishes a turn _and_ this tmux pane is not focused.

### TUI taste

- **`tui.ts`** — left/right padding, input line color, slim footer, editor pinned to viewport bottom even on a fresh session (filler blanks above shrink as conversation grows), autocomplete dropdown rendered as a floating overlay above the editor (covers conversation lines, restores them on close; editor stays put).
- **`code-bat.ts`** — monkey-patches the markdown renderer to use `bat` for syntax highlight. First render of a block ~50ms, memoized after.

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
