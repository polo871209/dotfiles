local M = {}

local MARKERS = { 'tsconfig.json', 'jsconfig.json', 'package.json', '.git' }

--- Returns the project root of `bufnr`, or nil outside any project.
function M.root(bufnr) return vim.fs.root(bufnr, MARKERS) end

--- TypeScript 7 ships the native compiler and no `lib/tsserver.js`, so tsserver clients such as vtsls cannot load it.
function M.is_native(root)
    local pkg = vim.fs.joinpath(root, 'node_modules', 'typescript')
    return vim.uv.fs_stat(vim.fs.joinpath(pkg, 'package.json')) ~= nil and vim.uv.fs_stat(vim.fs.joinpath(pkg, 'lib', 'tsserver.js')) == nil
end

return M
