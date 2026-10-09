local function is_xcode_project(name)
    local ext = vim.fs.ext(name)
    return ext == 'xcodeproj' or ext == 'xcworkspace'
end

return {
    cmd = { 'sourcekit-lsp' },
    filetypes = { 'swift' },
    root_dir = function(bufnr, on_dir) on_dir(vim.fs.root(bufnr, { { 'buildServer.json', '.bsp' }, is_xcode_project, 'Package.swift', '.git' })) end,
}
