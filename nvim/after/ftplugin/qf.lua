vim.cmd('resize ' .. math.floor(vim.o.lines * 0.45))

local is_loclist = vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].loclist == 1
local close = is_loclist and '<cmd>lclose<CR>' or '<cmd>cclose<CR>'
vim.keymap.set('n', '<CR>', '<CR>' .. close, { buffer = true, silent = true, desc = 'Jump and close list' })

require('ft').undo 'sil! nunmap <buffer> <CR>'
