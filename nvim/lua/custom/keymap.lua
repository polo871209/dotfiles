-- Clear search highlights
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Split screen
vim.keymap.set('n', '<leader>-', ':split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', ':vsplit<CR>', { desc = 'Vertical Split' })

-- Delete/change without yanking
vim.keymap.set('n', 'd', '"_d', { desc = 'Delete without yanking' })
vim.keymap.set('n', 'c', '"_c', { desc = 'Change without yanking' })

-- Paste without replacing clipboard
vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

-- Diffview toggle
local function toggle_diffview()
  local view = require('diffview.lib').get_current_view()
  if view then
    vim.cmd 'DiffviewClose'
  else
    vim.cmd 'DiffviewOpen'
  end
end

vim.keymap.set('n', '<leader>gd', toggle_diffview, { desc = '[G]it [D]iff Toggle' })
vim.keymap.set('n', '<leader>gc', ':DiffviewOpen ', { desc = '[G]it [C]ompare selection' })

-- Toggle diagnostics location list
vim.keymap.set('n', '<leader>tt', function()
  if vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 then
    vim.cmd 'lclose'
  else
    vim.diagnostic.setloclist()
    vim.cmd 'lopen'
  end
end, { desc = '[T]oggle [T]rouble' })

-- Auto-close location list on selection
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'qf',
  callback = function() vim.keymap.set('n', '<CR>', '<CR>:lclose<CR>', { buffer = true, silent = true }) end,
})

-- OpenCode integration
vim.keymap.set('x', '<leader><leader>', function() require('custom.opencode').send_selection() end, { desc = 'Send selection to OpenCode' })
vim.keymap.set('n', '<leader>da', function() require('custom.opencode').send_diagnostics() end, { desc = '[D]iagnostic [A]sk' })
