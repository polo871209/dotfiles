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

## Gotcha: `lsp/` config that reads fine and does nothing

A server config can be wrong in three ways that no error reports, so a `lsp/*.lua` change is not done until a fixture proves the server attached where you intended.

- `filetypes` must hold the filetype that detection returns, not the file extension. A non-empty `.tf` file is `terraform` while an empty one is `tf`, `.zon` is `zig`, and `.libsonnet` is `jsonnet`. A name that no file ever gets is a server that never attaches.
- `settings` reaches only a server that implements `workspace/didChangeConfiguration`. terraform-ls does not, so its settings must travel in `init_options` instead. A key that the server's documentation does not list is dead in either place.
- `root_markers` is a priority list, and a nested table is one rank. Wrong order roots too low, which is how a `go.work` workspace ends up with one gopls per module. Every rank that matches a nested directory also starts another client for the daemon to hold.

Verify with a fixture file instead of by reading the table. From a directory that carries the project markers:

```sh
nvim --headless -c 'edit fixture.tf' \
  -c 'lua vim.wait(15000, function() return #vim.lsp.get_clients { bufnr = 0 } > 0 end)' \
  -c 'lua local c = vim.lsp.get_clients { bufnr = 0 }[1]; print(vim.bo.filetype, c and c.name, c and c.root_dir)' +qa
```

Completion: the line prints the expected filetype, the intended server, and the intended root. A `nil` client means no attach, and a root above the fixture's project means the marker ranks are wrong. To confirm that a server accepted `init_options` or `settings`, read the `initialize` request it logged in `vim.lsp.log.get_filename()`.
