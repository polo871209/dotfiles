vim.pack.add {
  'https://github.com/folke/todo-comments.nvim',
  'https://github.com/wurli/visimatch.nvim',
  'https://github.com/MeanderingProgrammer/render-markdown.nvim',
  'https://github.com/folke/which-key.nvim',
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

require('quicker').setup {}
