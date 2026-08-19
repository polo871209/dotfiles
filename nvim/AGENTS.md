# nvim config

Two consumers: interactive nvim, and the pi agent's headless `--embed` instance (spawned with `vim.g.pi_agent = true` by `.pi/agent/extensions/lsp/`).

## Gotcha: agent nvim skips plugins

`plugin/` files guarded by `if vim.g.pi_agent then return end` (mini, treesitter, neo-tree, picker, …) never load in the agent instance. Referencing a skipped plugin from an unguarded file errors during embed startup and wedges the RPC channel — every pi edit then hangs forever.

Any configuration loaded by the agent instance that references a skipped plugin must gate that reference with `if not vim.g.pi_agent then ... end`. After changing such configuration, run:

```sh
nvim --headless --cmd "lua vim.g.pi_agent=true" +"lua print('agent-nvim ok')" +qa
```

Completion: command prints `agent-nvim ok` and exits 0. A hang means the agent lane is broken even if interactive nvim works.
