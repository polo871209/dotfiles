return {
    cmd = { 'vtsls', '--stdio' },
    filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' },
    root_markers = { 'tsconfig.json', 'jsconfig.json', 'package.json', '.git' },
    init_options = { hostInfo = 'neovim' },
    -- vtsls bundles its own TypeScript and prefers it, so a project pinned to
    -- an older version gets diagnostics its own compiler would not produce.
    -- autoUseWorkspaceTsdk alone does nothing: typescript.tsdk still has to
    -- name the workspace copy, and a static relative path makes vtsls warn and
    -- fall back on every project without one, hence the probe. Mutation is
    -- safe because nvim copies the config per root, and before_init is the
    -- last hook before nvim pushes the settings.
    before_init = function(_, config)
        local lib = config.root_dir and vim.fs.joinpath(config.root_dir, 'node_modules', 'typescript', 'lib')
        if lib and vim.uv.fs_stat(vim.fs.joinpath(lib, 'tsserver.js')) then config.settings.typescript.tsdk = lib end
    end,
    settings = {
        vtsls = { autoUseWorkspaceTsdk = true },
        typescript = {
            tsserver = { experimental = { enableProjectDiagnostics = not vim.g.pi_agent } },
        },
    },
}
