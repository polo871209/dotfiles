-- Agent nvim has no UI, so it skips the picker.
if vim.g.pi_agent then return end

-- Required lazily so the engine only loads on first use.
vim.keymap.set('n', '<leader><space>', function() require('picker').smart() end, { desc = 'Smart Find Files' })
vim.keymap.set('n', '<leader>sg', function() require('picker').grep { hidden = true } end, { desc = 'Grep' })
vim.keymap.set('n', '<leader>ss', function() require('picker').spelling() end, { desc = 'Spelling' })
