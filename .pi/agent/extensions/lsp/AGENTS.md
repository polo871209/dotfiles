# lsp — editing gotchas

Backed by a headless nvim instance driven by `nvim.ts` → `driver.lua`. Before changing Nvim configuration used by this subsystem, follow the plugin-skip invariant and smoke test in `../../../../nvim/AGENTS.md`.

Keep its two halves separate:

- `tools/*.ts` — navigation tools, registered in `index.ts`.
- `feedback/*` — post-edit formatting, diagnostics, and auto-fix, registered through `registerFeedback(pi)`.

For a new navigation tool, call `exposeRegisteredToolsToEval(pi)` before its `pi.registerTool(...)` call in `index.ts`. Do not register it through the feedback subsystem.

`nvim.ts` owns the nvim process lifecycle (spawn/teardown); `lsp-restart` command and `session_shutdown` hook both call `shutdownNvim()` — keep any new teardown path going through that one function, not a second kill path.
