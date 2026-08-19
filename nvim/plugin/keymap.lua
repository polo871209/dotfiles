vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

vim.keymap.set({ 'n', 'i' }, '<C-,>', '<cmd>bprevious<CR>', { desc = 'Previous Buffer' })
vim.keymap.set({ 'n', 'i' }, '<C-.>', '<cmd>bnext<CR>', { desc = 'Next Buffer' })

vim.keymap.set('n', '<leader>-', '<cmd>split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', '<cmd>vsplit<CR>', { desc = 'Vertical Split' })

local pane_directions = {
    { key = 'h', vim = 'h', tmux = '-L', name = 'Left' },
    { key = 'j', vim = 'j', tmux = '-D', name = 'Down' },
    { key = 'k', vim = 'k', tmux = '-U', name = 'Up' },
    { key = 'l', vim = 'l', tmux = '-R', name = 'Right' },
}
for _, direction in ipairs(pane_directions) do
    vim.keymap.set('n', '<C-' .. direction.key .. '>', function()
        local window = vim.api.nvim_get_current_win()
        vim.cmd('wincmd ' .. direction.vim)
        if window == vim.api.nvim_get_current_win() and vim.env.TMUX then vim.fn.system { 'tmux', 'select-pane', direction.tmux } end
    end, { desc = direction.name .. ' Pane' })
end

vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

-- Delete/change without yanking (dd, diw, ciw, etc.)
vim.keymap.set({ 'n', 'v' }, 'd', '"_d', { desc = 'Delete without yanking' })
vim.keymap.set({ 'n', 'v' }, 'c', '"_c', { desc = 'Change without yanking' })

-- Toggle diagnostics location list
vim.keymap.set('n', '<leader>tt', function()
    if vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 then
        vim.cmd 'lclose'
    else
        vim.diagnostic.setloclist()
        vim.cmd 'lopen'
    end
end, { desc = '[T]oggle [T]rouble' })

vim.keymap.set('n', '<leader>pu', function() vim.pack.update() end, { desc = '[P]ackage [U]pdate' })
vim.keymap.set('n', '<leader>ps', function() vim.pack.update(nil, { offline = true }) end, { desc = '[P]ackage [S]tatus' })
vim.keymap.set('n', '<leader>pl', function() vim.pack.update(nil, { target = 'lockfile' }) end, { desc = '[P]ackage [L]ockfile Sync' })

local toggle = require 'toggle'
toggle.option('<leader>tw', 'wrap', 'Wrap')
toggle.map('<leader>td', {
    name = 'Diagnostics',
    get = function() return vim.diagnostic.is_enabled() end,
    set = function(state) vim.diagnostic.enable(state) end,
})

vim.keymap.set('x', '<leader><leader>', function() require('pi').send_selection() end, { desc = 'Send selection to pi' })
vim.keymap.set('n', '<leader>da', function() require('pi').send_diagnostics() end, { desc = '[D]iagnostic [A]sk pi' })
