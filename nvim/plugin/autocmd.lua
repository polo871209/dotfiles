-- Global autocmds. Filetype-local behaviour belongs in after/ftplugin/<ft>.lua,
-- and plugin-specific autocmds stay with their plugin's file.

-- Nvim only equalizes splits when one is opened or closed, not when the terminal
-- itself shrinks: it takes the space out of whichever window is current, down to
-- 'winwidth' (20). Splitting a tmux pane next to nvim therefore squeezes the
-- focused split to a 20-column sliver instead of halving both.
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
