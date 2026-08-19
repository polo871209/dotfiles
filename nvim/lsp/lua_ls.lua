return {
    cmd = { 'lua-language-server' },
    filetypes = { 'lua' },
    root_markers = { { '.luarc.json', '.luarc.jsonc' }, '.git' },
    on_init = function(client)
        -- Skip config overrides when a .luarc.json exists in the workspace
        if client.workspace_folders then
            local path = client.workspace_folders[1].name
            if path ~= vim.fn.stdpath 'config' and (vim.uv.fs_stat(path .. '/.luarc.json') or vim.uv.fs_stat(path .. '/.luarc.jsonc')) then return end
        end
        -- stdpath('config') is a symlink into the dotfiles repo. Adding it to
        -- the library when it overlaps the workspace makes lua-ls load every
        -- file twice -- once per path -- and report every definition as a
        -- duplicate-set-field. Compare resolved paths and skip when either
        -- side contains the other.
        local library = { vim.env.VIMRUNTIME }
        local function resolve(path) return vim.uv.fs_realpath(path) or path end
        local function contains(a, b) return a == b or vim.startswith(b, a:gsub('/$', '') .. '/') end

        local config = resolve(vim.fn.stdpath 'config')
        local root = client.workspace_folders and resolve(client.workspace_folders[1].name)
        if not root or not (contains(root, config) or contains(config, root)) then library[#library + 1] = config end

        client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua or {}, {
            runtime = {
                version = 'LuaJIT',
                path = { 'lua/?.lua', 'lua/?/init.lua' },
            },
            workspace = {
                checkThirdParty = false,
                library = library,
            },
            completion = { callSnippet = 'Replace' },
            diagnostics = {
                disable = { 'missing-fields' },
                globals = { 'vim' },
            },
            hint = { enable = false },
        })
    end,
    settings = {
        Lua = { hint = { enable = false } },
    },
}
