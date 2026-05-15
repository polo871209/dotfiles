vim.pack.add {
  'https://github.com/folke/todo-comments.nvim',
  'https://github.com/wurli/visimatch.nvim',
  'https://github.com/folke/which-key.nvim',
  'https://github.com/stevearc/quicker.nvim',
}

require('todo-comments').setup { signs = false }
require('visimatch').setup {}

require('which-key').setup {
  delay = 200,
  spec = {
    { '<leader><leader>', group = 'OpenCode Ask' },
    { '<leader>b', group = 'De[B]ug' },
    { '<leader>g', group = '[G]it' },
    { '<leader>p', group = 'vim [P]ack' },
    { '<leader>r', group = '[R]un Code' },
    { '<leader>s', group = '[S]earch' },
    { '<leader>t', group = '[T]oggle' },
  },
}

require('quicker').setup {}

local render_markdown_loaded = false

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'markdown',
  callback = function()
    if render_markdown_loaded then return end
    render_markdown_loaded = true
    vim.pack.add { 'https://github.com/MeanderingProgrammer/render-markdown.nvim' }
    require('render-markdown').setup {}
  end,
})
