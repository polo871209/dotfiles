local ts_project = require 'ts_project'

return {
    cmd = function(dispatchers, config)
        local tsc = vim.fs.joinpath(config.root_dir, 'node_modules', '.bin', 'tsc')
        return vim.lsp.rpc.start({ tsc, '--lsp', '--stdio' }, dispatchers, { cwd = config.root_dir })
    end,
    filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' },
    root_dir = function(bufnr, on_dir)
        local root = ts_project.root(bufnr)
        if root and ts_project.is_native(root) then on_dir(root) end
    end,
}
