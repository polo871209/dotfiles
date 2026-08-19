-- Assigned by plugin/filetype.lua purely on size. Because the filetype is
-- `bigfile` rather than the real one, treesitter, LSP and syntax never attach;
-- what is left is to switch off the remaining per-buffer cost.

vim.b.completion = false -- blink.cmp reads this flag
vim.bo.swapfile = false
vim.bo.undofile = false

vim.opt_local.foldmethod = 'manual'
vim.opt_local.statuscolumn = ''
vim.opt_local.conceallevel = 0
vim.opt_local.list = false
vim.opt_local.spell = false
vim.opt_local.wrap = false

if vim.fn.exists ':NoMatchParen' ~= 0 then vim.cmd 'NoMatchParen' end

-- Deferred: 'cmdheight' is 0, so a message here hits the 'messagesopt'
-- wait:4000 path and blocks both the first redraw and the keystrokes typed
-- into it. After the schedule the buffer is already on screen.
vim.schedule(function() vim.notify('Big file: syntax, LSP and treesitter disabled', vim.log.levels.WARN) end)
