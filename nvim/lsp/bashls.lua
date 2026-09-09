return {
    cmd = { 'bash-language-server', 'start' },
    filetypes = { 'bash', 'sh' },
    -- Background analysis globs the whole workspace folder. With only a .git
    -- marker, a loose script such as ~/foo.sh resolves no root and the server
    -- falls back to the process cwd, so it can end up parsing every shell
    -- script under $HOME. The script's own directory bounds that.
    root_dir = function(bufnr, on_dir)
        local name = vim.api.nvim_buf_get_name(bufnr)
        on_dir(vim.fs.root(bufnr, '.git') or (name ~= '' and vim.fs.dirname(name) or nil))
    end,
}
