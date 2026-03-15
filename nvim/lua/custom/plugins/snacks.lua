return {
  'folke/snacks.nvim',
  priority = 1000,
  lazy = false,
  opts = {
    bigfile = {},
    indent = {},
    input = {},
    lazygit = {
      configure = false,
      win = { style = 'lazygit' },
    },
    picker = {
      layout = { fullscreen = true, preset = 'telescope' },
      formatters = {
        file = {
          min_width = 999,
        },
      },
      sources = {
        smart = {
          filter = { cwd = true },
        },
        files = {
          hidden = true,
        },
      },
    },
    gitbrowse = {
      remote_patterns = {
        { "^git@github%.com%-[^:]+:(.+)%.git$", "https://github.com/%1" },
        { "^git@github%.com%-[^:]+:(.+)$", "https://github.com/%1" },
        { "^(https?://.*)%.git$", "%1" },
        { "^git@(.+):(.+)%.git$", "https://%1/%2" },
        { "%.git$", "" },
      },
    },
    styles = {
      lazygit = { width = 0.99, height = 0.99 },
    },
    notifier = {
      level = vim.log.levels.INFO,
    },
    toggle = {},
    words = {},
  },
  keys = {
    { '<leader><space>', function() Snacks.picker.smart() end, desc = 'Smart Find Files' },
    { '<leader>sg', function() Snacks.picker.grep({ hidden = true, no_ignore = true }) end, desc = 'Grep' },
    { '<leader>/', function() Snacks.picker.grep_buffers() end, desc = 'Grep Open Buffers' },
    { '<leader>sn', function() Snacks.picker.notifications() end, desc = 'Notification History' },
    { '<leader>sk', function() Snacks.picker.keymaps() end, desc = 'Keymaps' },
    { '<leader>ss', function() Snacks.picker.spelling() end, desc = 'Spelling' },

    -- LSP
    { 'gd', function() Snacks.picker.lsp_definitions() end, desc = 'Goto Definition' },
    { 'gD', function() Snacks.picker.lsp_declarations() end, desc = 'Goto Declaration' },
    { 'gr', function() Snacks.picker.lsp_references() end, nowait = true, desc = 'References' },
    { 'gI', function() Snacks.picker.lsp_implementations() end, desc = 'Goto Implementation' },
    { 'gy', function() Snacks.picker.lsp_type_definitions() end, desc = 'Goto T[y]pe Definition' },

    { '<leader>lg', function() Snacks.lazygit() end, desc = '[L]azy[g]it' },
    { '<leader>gb', function() Snacks.git.blame_line() end, desc = '[G]it [B]lame Line' },
    { '<leader>gB', function() Snacks.gitbrowse() end, desc = '[G]it [B]rowse' },
    { '<leader>tn', function() Snacks.notifier.hide() end, desc = 'Dismiss All [N]otifications' },
  },
  init = function()
    vim.api.nvim_create_autocmd('User', {
      pattern = 'VeryLazy',
      callback = function()
        -- Toggle mappings
        Snacks.toggle.option('wrap', { name = 'Wrap' }):map '<leader>tw'
        Snacks.toggle.diagnostics():map '<leader>td'
      end,
    })
  end,
}
