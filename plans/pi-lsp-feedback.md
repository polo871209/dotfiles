# pi LSP-feedback Hook (nvim-driven, simple)

## Context
After pi finishes a turn, **format the touched files and report diagnostics
back to the agent**, reusing the user's existing nvim setup so there's no
config drift. Same shape as [pi-lens](https://github.com/apmantza/pi-lens),
but ~150 LOC across two files (TS extension + Lua driver).

The user's nvim config (already in `nvim/`) provides:

- `conform.nvim` — formatters per filetype, `lsp_format = 'fallback'`
  (`nvim/plugin/format.lua`).
- Native `vim.lsp.enable {...}` for 15 servers (`nvim/plugin/lsp.lua` +
  `nvim/lsp/*.lua`).
- `nvim-lint` — ruff (Python), hadolint (Dockerfile)
  (`nvim/plugin/lint.lua`).
- `vim.diagnostic` is the unified sink for all of the above.

Driving nvim headless means: any new LSP server, formatter, or linter the
user adds to their nvim config is automatically picked up by the hook. Zero
duplication.

## What we keep from pi-lens (recipe only)
- `tool_result(write|edit)` → collect touched files into a per-session `Set`.
- `agent_end` → run once per user prompt on the collected set, then clear.
- `before_agent_start` → reset the loop guard.
- Silent on clean (no diagnostics → no message).

Dropped: pi-lens's 8k LOC of LSP stdio clients, ast-grep, fact rules,
cascade graph, install prompts. We delegate **all** of that to nvim.

## Approach

Two files:

### 1. `.pi/extensions/lsp-feedback.ts` — the extension (~80 LOC)

```
session_start          → state.touched.clear(); reported = false
before_agent_start     → reported = false
tool_result(write|edit, !isError) → state.touched.add(absPath)
agent_end              → if touched empty or reported: return
                          run nvim driver on touched files (15s budget)
                          if non-empty diagnostics:
                            pi.sendUserMessage(text, { deliverAs: "followUp" })
                          state.touched.clear(); reported = true
```

Invocation:
```ts
const { stdout } = await pi.exec(
  "nvim",
  ["--headless", "-l", driverLuaPath, ...touchedFiles],
  { signal: ctx.signal, timeout: 15_000, cwd: ctx.cwd },
);
const result = JSON.parse(stdout) as DriverResult;
```

The driver prints a single JSON line on stdout; everything else
(`:messages`, plugin chatter) is dropped. Stderr is logged via `ctx.ui.notify`
only on hard failure.

### 2. `.pi/extensions/lsp-feedback.lua` — the nvim driver (~80 LOC)

Run as `nvim --headless -l lsp-feedback.lua <files...>`. It loads the user's
full `init.lua` (so `conform`, `nvim-lint`, and `vim.lsp.enable` all run as
normal), then for each file:

1. `vim.cmd.edit(file)` → buffer created, filetype detected, LSP servers
   auto-attach via the user's `vim.lsp.enable` config, `nvim-lint` fires on
   `BufEnter`.
2. **Format**: `require('conform').format({ bufnr = buf, async = false,
   lsp_format = 'fallback', timeout_ms = 3000 })`. If the buffer is now
   `modified`, `:write` it. Track which files were rewritten.
3. **Wait for LSP/lint to settle** — poll `vim.lsp.get_clients({ bufnr })`
   then `vim.wait(timeout, () => all_attached_clients_idle)`. Cap at 8s
   total across all files; servers that don't finish in time just don't
   contribute (best-effort, like pi-lens).
4. **Pull diagnostics for servers that support it**: for each attached
   client whose `server_capabilities.diagnosticProvider` is set, call
   `vim.lsp.buf_request_sync(buf, 'textDocument/diagnostic', ...)` and feed
   results into `vim.diagnostic.set` under a per-client namespace. (Push-mode
   servers will already have published.)
5. **Trigger nvim-lint explicitly**: `pcall(require('lint').try_lint)` —
   covers ruff/hadolint that the user's autocmd would normally fire on
   `BufEnter`.

After all files processed, collect:
```lua
local out = { formatted = {...}, diagnostics = {} }
for _, buf in ipairs(bufs) do
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    table.insert(out.diagnostics, {
      file = vim.api.nvim_buf_get_name(buf),
      line = d.lnum + 1, col = d.col + 1,
      severity = ({ "error", "warn", "info", "hint" })[d.severity],
      source = d.source, code = d.code, message = d.message,
    })
  end
end
io.stdout:write(vim.json.encode(out)); os.exit(0)
```

### Output format injected to the agent

Compact, agent-friendly, ≤50 lines, truncated:

```
[lsp-feedback] auto-formatted 2 file(s); 3 diagnostic(s) remain:
src/foo.ts:12:5  error  ts(2322): Type 'string' is not assignable to 'number'.
src/foo.ts:40:1  warn   eslint(no-unused-vars): 'bar' defined but never used.
src/bar.py:8:1   error  ruff(F821): undefined name 'baz'.
Files re-formatted on disk: src/foo.ts, src/bar.py — re-read before editing.
Please fix these before continuing.
```

If `formatted` non-empty but `diagnostics` empty → still send a short note so
the agent knows files changed on disk:

```
[lsp-feedback] auto-formatted 2 file(s) on disk: src/foo.ts, src/bar.py.
Re-read before editing.
```

If both empty → silent.

Delivery: `pi.sendUserMessage(text, { deliverAs: "followUp" })`. Loop guard
`reported` ensures at most one feedback per user prompt; resets in
`before_agent_start`.

## Edge cases / details
- **Files outside cwd / deleted / binary**: skip. Resolve to absolute path,
  `fs.existsSync`, ignore otherwise.
- **No nvim on PATH**: `notify("lsp-feedback: nvim not found", "warning")`
  once and bail.
- **Driver crashes / non-JSON stdout**: log via `ctx.ui.notify("error")`,
  don't inject anything.
- **Formatter rewrites file**: emitted in `formatted` array so the agent's
  next read sees fresh content. (pi's read-before-edit, if any, will reset
  via the disk mtime change.)
- **Big sets**: cap touched files at e.g. 25; beyond that just report
  `…and N more` without checking, to keep budget bounded.
- **Cold start**: ~1-2s for nvim + plugin load. Acceptable end-of-turn cost.

## Files to create
- **new** `.pi/extensions/lsp-feedback.ts`
- **new** `.pi/extensions/lsp-feedback.lua`

No changes to `.pi/agent/settings.json` — extensions auto-load from
`.pi/extensions/` (same as `notifier.ts`, `tmux-bridge.ts`).

## Reuse
- `.pi/extensions/notifier.ts` — module shape, default-export `(pi) => {}`.
- `.pi/extensions/tmux-bridge.ts` — per-session state lifecycle.
- pi extension API: `pi.on`, `pi.exec`, `pi.sendUserMessage`.
- User's nvim config — **everything LSP/format/lint comes from there**, no
  duplication: `nvim/plugin/lsp.lua`, `nvim/plugin/format.lua`,
  `nvim/plugin/lint.lua`, `nvim/lsp/*.lua`.

## Steps
- [ ] Create `.pi/extensions/lsp-feedback.lua`:
  - args = files; for each: `vim.cmd.edit`, detect ft, attach LSP, run
    `conform.format` (sync), `:write` if modified, pull-diag if supported,
    `lint.try_lint()`.
  - `vim.wait` loop with overall 8s cap to let async servers publish.
  - emit single JSON line on stdout: `{ formatted: string[], diagnostics: [...] }`.
- [ ] Create `.pi/extensions/lsp-feedback.ts`:
  - state `{ touched: Set<string>, reported: boolean }`.
  - hooks: `session_start`, `before_agent_start`, `tool_result`, `agent_end`.
  - `agent_end`: spawn nvim with driver, parse JSON, format message,
    `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
  - Helpers: `formatMessage(result)`, `truncate(lines, 50)`.
- [ ] (Optional) `/lsp-now` command: run the same logic on demand against
      the current touched set without waiting for `agent_end`.

## Verification
- Edit a `.ts` file with a deliberate type error → expect a follow-up user
  message with the diagnostic; agent fixes it.
- Edit a `.py` file that isn't formatted → expect the file to be reformatted
  on disk and the message to mention it.
- Edit a clean `.lua` file → no follow-up.
- Two prompts in a row, both with errors → feedback fires both times (loop
  guard resets per prompt).
- `nvim` not on PATH → single warning notify, no crash.
- LSP server slow to index (gopls cold) → 8s cap hits, message reflects
  whatever was published; doesn't block pi.
- Drift check: add a new formatter or LSP server in `nvim/`, no changes
  needed to `.pi/extensions/lsp-feedback.*`.
