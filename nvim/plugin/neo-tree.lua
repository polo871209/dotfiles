local ignore = require 'ignore'

local loaded = false
local function load_neotree()
  if loaded then return end
  loaded = true

  vim.pack.add {
    'https://github.com/nvim-lua/plenary.nvim',
    'https://github.com/nvim-tree/nvim-web-devicons',
    'https://github.com/MunifTanjim/nui.nvim',
    'https://github.com/nvim-neo-tree/neo-tree.nvim',
  }

  require('neo-tree').setup {
    filesystem = {
      filtered_items = {
        visible = false,
        show_hidden_count = false,
        hide_dotfiles = false,
        hide_by_name = ignore.names,
      },
      window = {
        mappings = {
          ['\\'] = 'close_window',
          ['<Right>'] = 'open',
          ['<Left>'] = 'close_node',
        },
      },
    },
    event_handlers = {
      {
        event = 'file_opened',
        handler = function()
          require('neo-tree.command').execute { action = 'close' }
        end,
      },
    },
  }
end

vim.keymap.set('n', '\\', function()
  load_neotree()
  local bufname = vim.api.nvim_buf_get_name(0)
  if bufname == '' or vim.bo.filetype == 'ministarter' or vim.bo.buftype ~= '' then
    vim.cmd 'Neotree toggle'
  else
    vim.cmd 'Neotree reveal'
  end
end, { desc = 'NeoTree toggle/reveal', silent = true })
