# lsp — editing gotchas

Backed by headless nvim daemons driven by `nvim.ts` → `driver.lua`. Before changing Nvim configuration used by this subsystem, follow the plugin-skip invariant and smoke test in `../../../../nvim/AGENTS.md`.

## The nvim is shared, not owned

One daemon per lane (`main`, `inline`) serves every pi process on the machine — a subagent is its own pi process, so per-session editors meant 2N nvim and 2N copies of every language server. `nvim.ts` connects to `~/.cache/pi-lsp/<lane>.sock` and only spawns `nvim --headless --listen` (detached, bootstrapped by `daemon.lua`) when nobody has yet.

That socket path must be derivable from nothing but `$HOME`. It reads as a free choice and it isn't: any env input (`TMPDIR`, `XDG_RUNTIME_DIR`) splits the pool the moment one tmux pane exports it and the next doesn't, and the symptom is not an error but a second daemon nobody notices.

Three consequences constrain any change here:

- Teardown is asymmetric. `session_shutdown` calls `disconnectNvim()`, which closes this process's socket and nothing else; the daemon exits on its own once no client has been connected for `IDLE_EXIT_MS`. Only `restartDaemons()` kills, and it kills for everyone — that is what the `lsp-restart` command and the tool's `restart` action do. Never add a kill on a session-scoped path.
- Nothing in the daemon may be assumed private. Buffers, `_G.PiLsp`, and language servers outlive the session that created them and are shared with peers, so lua state has to be keyed by file, not by session, and `loadLuaOnce` decides freshness from the daemon's own epoch plus a source hash rather than any local counter.
- Concurrent clients are real. `PiDaemon.guard` (daemon.lua) admits one driver call at a time and _bounces_ the rest with `{ __pi_busy = true }` for the client to retry; it must never wait, because a driver call's `vim.wait` pumps the loop and would run the waiter inside the holder's frame, which deadlocks both. Route every new entry point into the daemon through `callLua`/`callDriver`/`loadLuaOnce` so it inherits the guard.

Resource ceilings live at the two ends: `driver.lua`'s `M.gc` (LRU buffer cap, then stop servers left with no live buffer) runs from the daemon sweep, and `nvim/lsp/vtsls.lua` drops `enableProjectDiagnostics` under `vim.g.pi_agent`. `PI_LSP_IDLE_MS`, `PI_LSP_SWEEP_MS`, `PI_LSP_MAX_BUFS`, and `PI_LSP_BUF_IDLE_MS` override the defaults, which is also how to test the reapers without waiting minutes.

Keep its two halves separate:

- `tool.ts` — single consolidated `lsp` tool with an `action` enum (hover/definition/references/implementation/type_definition/document_symbols/diagnostics/rename/restart), registered in `index.ts`. Add new navigation ops as a new action here, not a new tool — one `action` enum is far cheaper in schema tokens than N separate tools with duplicated file/line/symbol params. `rename` is the only write action; it applies and saves immediately (no preview mode).
- `feedback/*` — post-edit formatting, diagnostics, and auto-fix, registered through `registerFeedback(pi)`.

## The repair follow-up outlives the turn

`feedback/*` can send a repair follow-up after pi already fired `agent_settled`, so an extension that reports completion on that event reports it too early. `../shared/turn-gate.ts` closes the window: the pass claims the gate on the first tracked edit and releases it with `turnContinues` once it knows whether it sent the follow-up. The consumers are the desktop ping and tmux title in `../notifier.ts` and the subagent result file in `../subagent.ts`. New post-turn work that can start a turn must take a claim, and a new completion signal must wait on the gate.

The gate talks over `pi.events` and not over module state. The loader builds a separate jiti module graph per extension (`moduleCache: false`), so two extensions that import the same file get two copies of its variables. The event bus is the one object they share.

`exposeRegisteredToolsToEval(pi)` in `index.ts` must run before `pi.registerTool(lspTool)` so eval cells can call `tool.lsp({...})`. Do not register it through the feedback subsystem.

Closing the socket must use `end()`, not `destroy()`: the msgpack decoder wrapped around it rejects with `ERR_STREAM_PREMATURE_CLOSE` on an abrupt teardown and nothing in the `neovim` package catches it, so a `destroy()` on the shutdown path takes the pi process down with an unhandled rejection. For the same reason `qall!` is sent with a bounded wait — it kills the channel mid-request, so its reply never arrives and a plain `await` hangs forever.
