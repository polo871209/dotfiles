# nvim config

Two consumers: interactive nvim, and the pi agent's headless `--embed` instance (spawned with `vim.g.pi_agent = true` by `.pi/agent/extensions/lsp/`).

## Gotcha: agent nvim skips plugins

`plugin/` files guarded by `if vim.g.pi_agent then return end` (snacks, mini, treesitter, …) never load in the agent instance. Referencing a skipped plugin from an unguarded file errors during embed startup and wedges the RPC channel — every pi edit then hangs forever.

When changing `plugin/*.lua`, gate any cross-file reference to a guarded plugin with `if not vim.g.pi_agent then ... end`, then verify the agent instance still answers:

```sh
nvim --headless --cmd "lua vim.g.pi_agent=true" +"lua print('agent-nvim ok')" +qa
```

Must print `agent-nvim ok` and exit — a hang means the agent lane is broken even if interactive nvim works.
