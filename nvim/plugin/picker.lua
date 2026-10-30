if vim.g.pi_agent then return end

vim.keymap.set('n', '<leader><space>', function() require('picker').smart() end, { desc = 'Smart Find Files' })
vim.keymap.set('n', '<leader>sg', function() require('picker').grep { hidden = true } end, { desc = 'Grep' })
vim.keymap.set('n', '<leader>ss', function() require('picker').spelling() end, { desc = 'Spelling' })

vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function()
        local empty_start = vim.fn.argc() == 0
            and #vim.api.nvim_list_uis() > 0
            and vim.api.nvim_buf_get_name(0) == ''
            and vim.bo.buftype == ''
            and vim.api.nvim_buf_line_count(0) == 1
            and vim.api.nvim_buf_get_lines(0, 0, 1, true)[1] == ''
        if empty_start then require('picker').smart() end
    end,
})
