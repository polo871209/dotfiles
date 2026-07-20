# lsp — editing gotchas

Backed by a headless nvim instance driven by `nvim.ts` → `driver.lua`. That instance is a consumer of `~/dotfiles/nvim`'s config — see `nvim/AGENTS.md` for the `vim.g.pi_agent` plugin-skip gotcha before touching anything that crosses into nvim config territory.

Two halves, don't cross-wire them:

- `tools/*.ts` — pull: nav tools (`hover`, `definition`, `references`, `symbols`, `navigation`, `diagnostics`), registered in `index.ts` via `exposeRegisteredToolsToEval` so they're also callable from eval cells.
- `feedback/*` — push: post-edit format + batched diagnostics + LLM auto-fix, registered separately via `registerFeedback(pi)`.

New nav tool: register in `index.ts` with `pi.registerTool`, not manually — that call is wrapped to also expose it to eval cells.

`nvim.ts` owns the nvim process lifecycle (spawn/teardown); `lsp-restart` command and `session_shutdown` hook both call `shutdownNvim()` — keep any new teardown path going through that one function, not a second kill path.
