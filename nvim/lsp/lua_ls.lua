return {
  cmd = { 'lua-language-server' },
  filetypes = { 'lua' },
  root_markers = { { '.luarc.json', '.luarc.jsonc' }, '.git' },
  on_init = function(client)
    -- Skip config overrides when a .luarc.json exists in the workspace
    if client.workspace_folders then
      local path = client.workspace_folders[1].name
      if path ~= vim.fn.stdpath 'config'
        and (vim.uv.fs_stat(path .. '/.luarc.json') or vim.uv.fs_stat(path .. '/.luarc.jsonc'))
      then
        return
      end
    end
    client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua or {}, {
      runtime = {
        version = 'LuaJIT',
        path = { 'lua/?.lua', 'lua/?/init.lua' },
      },
      workspace = {
        checkThirdParty = false,
        library = {
          vim.env.VIMRUNTIME,
          vim.fn.stdpath 'config',
        },
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
