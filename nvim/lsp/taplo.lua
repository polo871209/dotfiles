return {
    cmd = { 'taplo', 'lsp', 'stdio' },
    filetypes = { 'toml' },
    -- taplo.toml carries the schema mapping and the formatter rules, so the
    -- directory holding it is the root, ahead of the repository root.
    root_markers = { '.taplo.toml', 'taplo.toml', '.git' },
}
