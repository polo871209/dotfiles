vim.api.nvim_create_autocmd('VimResized', {
    desc = 'Re-equalize splits after the terminal is resized',
    group = vim.api.nvim_create_augroup('resize-equalize', { clear = true }),
    command = 'wincmd =',
})

vim.api.nvim_create_autocmd('TextYankPost', {
    desc = 'Highlight when yanking text',
    group = vim.api.nvim_create_augroup('highlight-yank', { clear = true }),
    callback = function() vim.hl.on_yank() end,
})
