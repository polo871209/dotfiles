-- Global autocmds. Filetype-local behaviour belongs in after/ftplugin/<ft>.lua,
-- and plugin-specific autocmds stay with their plugin's file.

vim.api.nvim_create_autocmd('TextYankPost', {
    desc = 'Highlight when yanking text',
    group = vim.api.nvim_create_augroup('highlight-yank', { clear = true }),
    callback = function() vim.hl.on_yank() end,
})
