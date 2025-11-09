return {
  'nvim-neo-tree/neo-tree.nvim',
  version = '*',
  dependencies = {
    'nvim-lua/plenary.nvim',
    'nvim-tree/nvim-web-devicons',
    'MunifTanjim/nui.nvim',
  },
  keys = {
    {
      '\\',
      function()
        local bufname = vim.api.nvim_buf_get_name(0)
        -- Check if current buffer is a real file
        if bufname == '' or vim.bo.filetype == 'ministarter' or vim.bo.buftype ~= '' then
          -- Not a real file, just toggle neo-tree without reveal
          vim.cmd('Neotree toggle')
        else
          -- Real file, reveal it in neo-tree
          vim.cmd('Neotree reveal')
        end
      end,
      desc = 'NeoTree toggle/reveal',
      silent = true,
    },
  },
  opts = {
    filesystem = {
      filtered_items = {
        visible = false,
        show_hidden_count = false,
        hide_dotfiles = false,
        hide_by_name = {
          '.git',
          '.DS_Store',
          '.terraform',
        },
      },
      window = {
        mappings = {
          ['\\'] = 'close_window',
        },
      },
    },
    event_handlers = {
      {
        event = 'file_opened',
        handler = function()
          -- Automatically close the Neo-tree window after selecting a file
          require('neo-tree.command').execute({ action = 'close' })
        end,
      },
    },
  },
}
