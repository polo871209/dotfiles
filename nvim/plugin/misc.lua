vim.pack.add {
  'https://github.com/christoomey/vim-tmux-navigator',
  'https://github.com/folke/flash.nvim',
  'https://github.com/windwp/nvim-autopairs',
  'https://github.com/NMAC427/guess-indent.nvim',
  'https://github.com/ekalinin/Dockerfile.vim',
  'https://github.com/lewis6991/gitsigns.nvim',
  'https://github.com/sindrets/diffview.nvim',
}

-- Tmux navigation
vim.keymap.set('n', '<c-h>', '<cmd><C-U>TmuxNavigateLeft<cr>')
vim.keymap.set('n', '<c-j>', '<cmd><C-U>TmuxNavigateDown<cr>')
vim.keymap.set('n', '<c-k>', '<cmd><C-U>TmuxNavigateUp<cr>')
vim.keymap.set('n', '<c-l>', '<cmd><C-U>TmuxNavigateRight<cr>')

-- Flash jump
vim.keymap.set('n', 's', function() require('flash').jump() end, { desc = 'Flash' })
vim.keymap.set('n', 'S', function() require('flash').treesitter() end, { desc = 'Flash Treesitter' })

require('nvim-autopairs').setup {}
require('guess-indent').setup {}

require('gitsigns').setup {
  signs = {
    add = { text = '+' },
    change = { text = '~' },
    delete = { text = '_' },
    topdelete = { text = '‾' },
    changedelete = { text = '~' },
  },
}
