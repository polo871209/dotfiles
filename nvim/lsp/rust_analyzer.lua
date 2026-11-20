local cargo_home = vim.env.CARGO_HOME or vim.fs.joinpath(vim.env.HOME, '.cargo')
local rustup_home = vim.env.RUSTUP_HOME or vim.fs.joinpath(vim.env.HOME, '.rustup')
local LIBRARY_DIRS = {
    vim.fs.joinpath(cargo_home, 'registry', 'src'),
    vim.fs.joinpath(cargo_home, 'git', 'checkouts'),
    vim.fs.joinpath(rustup_home, 'toolchains'),
}

---@param path string
---@return string?
local function running_root_for_library(path)
    for _, dir in ipairs(LIBRARY_DIRS) do
        if vim.fs.relpath(dir, path) then
            local clients = vim.lsp.get_clients { name = 'rust_analyzer' }
            local last = clients[#clients]
            return last and last.root_dir
        end
    end
end

-- rust-analyzer reads its configuration from initializationOptions at startup and pulls `settings` on change.
local settings = {
    check = { command = 'clippy' },
    -- Builds into target/rust-analyzer so that a terminal `cargo build` does not wait on the check's lock.
    cargo = { targetDir = true },
}

---@type vim.lsp.Config
return {
    cmd = { 'rust-analyzer' },
    filetypes = { 'rust' },
    root_dir = function(bufnr, on_dir)
        local path = vim.api.nvim_buf_get_name(bufnr)
        local library_root = running_root_for_library(path)
        if library_root then return on_dir(library_root) end

        local crate_dir = vim.fs.root(path, 'Cargo.toml')
        if not crate_dir then return on_dir(vim.fs.root(path, { 'rust-project.json', '.git' })) end

        -- --manifest-path keeps the path as given, while a cwd lookup resolves symlinks such as /tmp.
        local cmd = { 'cargo', 'locate-project', '--workspace', '--message-format', 'plain', '--manifest-path', vim.fs.joinpath(crate_dir, 'Cargo.toml') }
        vim.system(cmd, { text = true }, function(out) on_dir(out.code == 0 and vim.fs.dirname(vim.trim(out.stdout)) or crate_dir) end)
    end,
    init_options = settings,
    settings = { ['rust-analyzer'] = settings },
}
