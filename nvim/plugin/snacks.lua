vim.pack.add { 'https://github.com/folke/snacks.nvim' }

local ignore = require 'ignore'
local snacks = require 'snacks'

snacks.setup {
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
    exclude = ignore.patterns,
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
      { '^git@github%.com%-[^:]+:(.+)%.git$', 'https://github.com/%1' },
      { '^git@github%.com%-[^:]+:(.+)$', 'https://github.com/%1' },
      { '^(https?://.*)%.git$', '%1' },
      { '^git@(.+):(.+)%.git$', 'https://%1/%2' },
      { '%.git$', '' },
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
}

-- Picker keymaps
vim.keymap.set('n', '<leader><space>', function() snacks.picker.smart() end, { desc = 'Smart Find Files' })
vim.keymap.set('n', '<leader>sg', function() snacks.picker.grep { hidden = true, no_ignore = true } end, { desc = 'Grep' })
vim.keymap.set('n', '<leader>/', function() snacks.picker.grep_buffers() end, { desc = 'Grep Open Buffers' })
vim.keymap.set('n', '<leader>sn', function() snacks.picker.notifications() end, { desc = 'Notification History' })
vim.keymap.set('n', '<leader>sk', function() snacks.picker.keymaps() end, { desc = 'Keymaps' })
vim.keymap.set('n', '<leader>ss', function() snacks.picker.spelling() end, { desc = 'Spelling' })

-- LSP pickers
vim.keymap.set('n', 'gd', function() snacks.picker.lsp_definitions() end, { desc = 'Goto Definition' })
vim.keymap.set('n', 'gD', function() snacks.picker.lsp_declarations() end, { desc = 'Goto Declaration' })
vim.keymap.set('n', 'gr', function() snacks.picker.lsp_references() end, { nowait = true, desc = 'References' })
vim.keymap.set('n', 'gI', function() snacks.picker.lsp_implementations() end, { desc = 'Goto Implementation' })
vim.keymap.set('n', 'gy', function() snacks.picker.lsp_type_definitions() end, { desc = 'Goto T[y]pe Definition' })

-- Git keymaps
vim.keymap.set('n', '<leader>lg', function() snacks.lazygit() end, { desc = '[L]azy[g]it' })
vim.keymap.set('n', '<leader>gb', function() snacks.git.blame_line() end, { desc = '[G]it [B]lame Line' })
vim.keymap.set('n', '<leader>gB', function() snacks.gitbrowse() end, { desc = '[G]it [B]rowse' })
vim.keymap.set('n', '<leader>tn', function() snacks.notifier.hide() end, { desc = 'Dismiss All [N]otifications' })

-- Toggle mappings (deferred so Snacks global is fully initialized)
vim.schedule(function()
  snacks.toggle.option('wrap', { name = 'Wrap' }):map '<leader>tw'
  snacks.toggle.diagnostics():map '<leader>td'
end)
