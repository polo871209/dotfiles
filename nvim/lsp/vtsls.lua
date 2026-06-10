return {
    cmd = { 'vtsls', '--stdio' },
    filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' },
    root_markers = { 'tsconfig.json', 'jsconfig.json', 'package.json', '.git' },
    -- settings = {
    --     typescript = {
    --         tsserver = { experimental = { enableProjectDiagnostics = true } },
    --     },
    -- },
}
