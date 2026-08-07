# lsp — editing gotchas

Backed by a headless nvim instance driven by `nvim.ts` → `driver.lua`. Before changing Nvim configuration used by this subsystem, follow the plugin-skip invariant and smoke test in `../../../../nvim/AGENTS.md`.

Keep its two halves separate:

- `tool.ts` — single consolidated `lsp` tool with an `action` enum (hover/definition/references/implementation/type_definition/document_symbols/diagnostics/rename), registered in `index.ts`. Add new navigation ops as a new action here, not a new tool — one `action` enum is far cheaper in schema tokens than N separate tools with duplicated file/line/symbol params. `rename` is the only write action; it applies and saves immediately (no preview mode).
- `feedback/*` — post-edit formatting, diagnostics, and auto-fix, registered through `registerFeedback(pi)`.

`exposeRegisteredToolsToEval(pi)` in `index.ts` must run before `pi.registerTool(lspTool)` so eval cells can call `tool.lsp({...})`. Do not register it through the feedback subsystem.

`nvim.ts` owns the nvim process lifecycle (spawn/teardown); `lsp-restart` command and `session_shutdown` hook both call `shutdownNvim()` — keep any new teardown path going through that one function, not a second kill path.
