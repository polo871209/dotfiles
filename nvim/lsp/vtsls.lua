return {
    cmd = { 'vtsls', '--stdio' },
    filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' },
    root_markers = { 'tsconfig.json', 'jsconfig.json', 'package.json', '.git' },
    settings = {
        typescript = {
            -- Buys diagnostics for files nobody opened, at the cost of a third
            -- tsserver process per project (the heaviest of the three, ~1.5GB
            -- peak). The agent only ever asks about files it opens explicitly,
            -- so headless it is pure overhead.
            tsserver = { experimental = { enableProjectDiagnostics = not vim.g.pi_agent } },
        },
    },
}
