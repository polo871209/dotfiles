# nvim config

Two consumers: interactive nvim, and the pi agent's shared headless daemons (spawned with `vim.g.pi_agent = true` by `.pi/agent/extensions/lsp/`, one per lane for the whole machine).

## Gotcha: agent nvim skips plugins

`plugin/` files guarded by `if vim.g.pi_agent then return end` (mini, treesitter, neo-tree, picker, …) never load in the agent instance. Referencing a skipped plugin from an unguarded file errors during embed startup and wedges the RPC channel — every pi edit then hangs forever.

Any configuration loaded by the agent instance that references a skipped plugin must gate that reference with `if not vim.g.pi_agent then ... end`. After changing such configuration, run:

```sh
nvim --headless --cmd "luafile .pi/agent/extensions/lsp/daemon.lua" +"lua print('agent-nvim ok')" +qa
```

Completion: command prints `agent-nvim ok` and exits 0. A hang means the agent lane is broken even if interactive nvim works.

Configuration also has to survive being shared: the daemon roams across projects and lives for hours, so anything scoped to a single project or a single run (a cwd-relative path, a one-shot autocmd standing in for state) is wrong under `vim.g.pi_agent`. Prefer buffer-local and `root_markers`-resolved settings, and prefer per-project cost over per-session cost — a setting that adds a process per project (`enableProjectDiagnostics`) is now paid once, but paid for as long as the daemon lives.
