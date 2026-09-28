local ft = require 'ft'

ft.prose()

-- One paragraph is one line. The runtime ftplugin turns on auto-wrap
-- ('formatoptions' t and c), which only sleeps because 'textwidth' is 0 here;
-- any project or plugin that sets a width would start breaking prose mid-typing.
vim.opt_local.textwidth = 0
vim.opt_local.formatoptions:remove { 't', 'c' }
ft.undo 'setl tw< fo<'

if not vim.g.pi_agent and vim.fn.has 'mac' == 1 then
    vim.keymap.set('n', '<leader>tm', function() require('mdview').toggle() end, { buffer = true, desc = '[T]oggle [M]arkdown Preview' })
    ft.undo 'silent! nunmap <buffer> <leader>tm'
end
