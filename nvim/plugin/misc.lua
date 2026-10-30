if vim.g.pi_agent then return end

vim.pack.add { 'https://github.com/folke/flash.nvim' }

vim.keymap.set('n', 's', function() require('flash').jump() end, { desc = 'Flash' })
vim.keymap.set('n', 'S', function() require('flash').treesitter() end, { desc = 'Flash Treesitter' })
