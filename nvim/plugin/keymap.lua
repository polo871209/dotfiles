vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

vim.keymap.set({ 'n', 'i' }, '<C-,>', '<cmd>bprevious<CR>', { desc = 'Previous Buffer' })
vim.keymap.set({ 'n', 'i' }, '<C-.>', '<cmd>bnext<CR>', { desc = 'Next Buffer' })

vim.keymap.set('n', '<leader>-', '<cmd>split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', '<cmd>vsplit<CR>', { desc = 'Vertical Split' })

---@param arg string
local function wincmd(arg)
    if vim.fn.getcmdwintype() ~= '' then return end
    vim.cmd('wincmd ' .. arg)
end

---@param direction 'h'|'j'|'k'|'l'
local function navigate(direction) wincmd(direction) end

local function last_active() wincmd 'p' end

local function next_pane() wincmd 'w' end

vim.keymap.set('n', '<C-h>', function() navigate 'h' end, { desc = 'Left Pane' })
vim.keymap.set('n', '<C-j>', function() navigate 'j' end, { desc = 'Down Pane' })
vim.keymap.set('n', '<C-k>', function() navigate 'k' end, { desc = 'Up Pane' })
vim.keymap.set('n', '<C-l>', function() navigate 'l' end, { desc = 'Right Pane' })
vim.keymap.set('n', '<C-\\>', last_active, { desc = 'Last Active Pane' })
vim.keymap.set('n', '<C-Space>', next_pane, { desc = 'Next Pane' })

vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

vim.keymap.set({ 'n', 'v' }, 'd', '"_d', { desc = 'Delete without yanking' })
vim.keymap.set({ 'n', 'v' }, 'c', '"_c', { desc = 'Change without yanking' })

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
