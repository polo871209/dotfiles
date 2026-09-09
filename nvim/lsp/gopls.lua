return {
    cmd = { 'gopls' },
    filetypes = { 'go', 'gomod', 'gowork', 'gotmpl' },
    -- Priority order, not a flat set (nested tables share one rank): go.work
    -- has to win over the go.mod next to the file, otherwise every module of a
    -- multi-module workspace gets its own gopls and cross-module definitions,
    -- references and renames stop resolving.
    root_markers = { 'go.work', { 'go.mod', 'go.sum' }, '.git' },
    settings = {
        -- gopls 0.22 stopped advertising semantic tokens unless the client
        -- asks for them.
        gopls = { semanticTokens = true },
    },
}
