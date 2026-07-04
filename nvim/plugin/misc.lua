-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

vim.pack.add {
    'https://github.com/folke/flash.nvim',
    'https://github.com/windwp/nvim-autopairs',
    'https://github.com/NMAC427/guess-indent.nvim',
    'https://github.com/lewis6991/gitsigns.nvim',
}

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
