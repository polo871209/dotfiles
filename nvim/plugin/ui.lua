vim.pack.add {
  'https://github.com/folke/todo-comments.nvim',
  'https://github.com/wurli/visimatch.nvim',
  'https://github.com/MeanderingProgrammer/render-markdown.nvim',
  'https://github.com/folke/which-key.nvim',
  'https://github.com/folke/noice.nvim',
  'https://github.com/stevearc/quicker.nvim',
}

require('todo-comments').setup { signs = false }
require('visimatch').setup {}
require('render-markdown').setup {}

require('which-key').setup {
  delay = 200,
  spec = {
    { '<leader><leader>', group = 'OpenCode Ask' },
    { '<leader>b', group = 'De[B]ug' },
    { '<leader>g', group = '[G]it' },
    { '<leader>m', group = 'Split/Join' },
    { '<leader>p', group = 'vim [P]ack' },
    { '<leader>s', group = '[S]earch' },
    { '<leader>t', group = '[T]oggle' },
    { 'g', group = 'LSP Actions', mode = { 'n' } },
  },
}

require('noice').setup {
  presets = {
    bottom_search = true,
  },
  cmdline = {
    enabled = true,
    view = 'cmdline_popup',
  },
  views = {
    cmdline_popup = {
      position = { row = 3, col = '50%' },
    },
  },
  -- Disable everything else to prevent behavior changes
  messages = { enabled = false },
  popupmenu = { enabled = false },
  notify = { enabled = false },
  lsp = {
    progress = { enabled = false },
    hover = { enabled = false },
    signature = { enabled = false },
    message = { enabled = false },
  },
}

require('quicker').setup {}
