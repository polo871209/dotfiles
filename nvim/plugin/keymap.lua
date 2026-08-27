vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

vim.keymap.set({ 'n', 'i' }, '<C-,>', '<cmd>bprevious<CR>', { desc = 'Previous Buffer' })
vim.keymap.set({ 'n', 'i' }, '<C-.>', '<cmd>bnext<CR>', { desc = 'Next Buffer' })

vim.keymap.set('n', '<leader>-', '<cmd>split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', '<cmd>vsplit<CR>', { desc = 'Vertical Split' })

-- Move between nvim splits first, hand the key to tmux only at the edges.
-- tmux/tmux.conf binds the same keys and forwards them here whenever the pane
-- runs nvim, so both sides must agree or the sender eats them.
local function tmux(...)
    -- $TMUX is "socket,pid,session"; -S pins the command to that server so a
    -- non-default socket (tmux -L) still resolves.
    local socket = vim.split(vim.env.TMUX, ',')[1]
    local cmd = { 'tmux', '-S', socket, ... }
    return vim.system(cmd, { text = true }):wait().stdout or ''
end

local function is_zoomed() return vim.trim(tmux('display-message', '-p', '#{window_zoomed_flag}')) == '1' end

--- `wincmd` throws E11 in the command-line window; nothing to navigate there.
---@param arg string
local function wincmd(arg) pcall(vim.cmd, 'wincmd ' .. arg) end

local tmux_pane = { h = '-L', j = '-D', k = '-U', l = '-R' }

-- Whether the last hop crossed out of nvim, so <C-\> knows which side owns
-- "previous". A fresh nvim was entered from tmux, hence the initial true.
local came_from_tmux = true

---@param direction 'h'|'j'|'k'|'l'
local function navigate(direction)
    local win = vim.api.nvim_get_current_win()
    wincmd(direction)
    if win ~= vim.api.nvim_get_current_win() then
        came_from_tmux = false
        return
    end
    -- No split that way, so tmux takes over. A zoomed pane is deliberately
    -- fullscreen, so leaving it on <C-hjkl> is almost never what was meant.
    if not vim.env.TMUX or is_zoomed() then return end
    tmux('select-pane', tmux_pane[direction])
    came_from_tmux = true
end

local function last_active()
    if vim.env.TMUX and came_from_tmux then return tmux('select-pane', '-l') end
    wincmd 'p'
end

-- Cycles every split, then every tmux pane: on the last split, wrap back to the
-- first one and let tmux advance instead.
local function next_pane()
    if vim.env.TMUX and vim.fn.winnr() == vim.fn.winnr '$' then
        wincmd 't'
        return tmux('select-pane', '-t:.+')
    end
    wincmd 'w'
end

vim.keymap.set('n', '<C-h>', function() navigate 'h' end, { desc = 'Left Pane' })
vim.keymap.set('n', '<C-j>', function() navigate 'j' end, { desc = 'Down Pane' })
vim.keymap.set('n', '<C-k>', function() navigate 'k' end, { desc = 'Up Pane' })
vim.keymap.set('n', '<C-l>', function() navigate 'l' end, { desc = 'Right Pane' })
vim.keymap.set('n', '<C-\\>', last_active, { desc = 'Last Active Pane' })
vim.keymap.set('n', '<C-Space>', next_pane, { desc = 'Next Pane' })

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
