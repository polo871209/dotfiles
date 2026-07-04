---@diagnostic disable: undefined-field
-- Clear search highlights
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Buffer navigation
vim.keymap.set({ 'n', 'i' }, '<C-,>', '<cmd>bprevious<CR>', { desc = 'Previous Buffer' })
vim.keymap.set({ 'n', 'i' }, '<C-.>', '<cmd>bnext<CR>', { desc = 'Next Buffer' })

-- Split screen
vim.keymap.set('n', '<leader>-', '<cmd>split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', '<cmd>vsplit<CR>', { desc = 'Vertical Split' })

-- Paste without replacing clipboard
vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

-- Diffview toggle
local diffview_loaded = false
local function load_diffview()
    if diffview_loaded then return end
    diffview_loaded = true
    vim.pack.add {
        'https://github.com/nvim-lua/plenary.nvim',
        'https://github.com/sindrets/diffview.nvim',
    }
end

local function toggle_diffview()
    load_diffview()
    local view = require('diffview.lib').get_current_view()
    if view then
        vim.cmd 'DiffviewClose'
    else
        vim.cmd 'DiffviewOpen'
    end
end

vim.keymap.set('n', '<leader>gd', toggle_diffview, { desc = '[G]it [D]iff Toggle' })
vim.keymap.set('n', '<leader>gc', function()
    load_diffview()
    vim.api.nvim_feedkeys(':DiffviewOpen ', 'n', false)
end, { desc = '[G]it [C]ompare selection' })

-- Toggle diagnostics location list
vim.keymap.set('n', '<leader>tt', function()
    if vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 then
        vim.cmd 'lclose'
    else
        vim.diagnostic.setloclist()
        vim.cmd 'lopen'
    end
end, { desc = '[T]oggle [T]rouble' })

-- Auto-close quickfix/loclist on selection
vim.api.nvim_create_autocmd('FileType', {
    pattern = 'qf',
    group = vim.api.nvim_create_augroup('QuickfixCloseOnEnter', { clear = true }),
    callback = function()
        local is_loclist = vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].loclist == 1
        local close = is_loclist and '<cmd>lclose<CR>' or '<cmd>cclose<CR>'
        vim.keymap.set('n', '<CR>', '<CR>' .. close, { buffer = true, silent = true })
    end,
})

-- Keymaps for vim.pack
vim.keymap.set('n', '<leader>pu', function() vim.pack.update() end, { desc = '[P]ackage [U]pdate' })
vim.keymap.set('n', '<leader>ps', function() vim.pack.update(nil, { offline = true }) end, { desc = '[P]ackage [S]tatus' })
vim.keymap.set('n', '<leader>pl', function() vim.pack.update(nil, { target = 'lockfile' }) end, { desc = '[P]ackage [L]ockfile Sync' })

-- Run: resolve project root and command from .nvim-run, falls back to `just`
local function get_run_cmd()
    local root = vim.fs.root(0, { '.git', '.nvim-run', 'Justfile' }) or vim.fn.getcwd()
    local cmd = 'just'
    local run_file = root .. '/.nvim-run'
    local f = io.open(run_file, 'r')
    if f then
        cmd = vim.trim(f:read '*a')
        f:close()
    end
    return cmd, root
end

-- <leader>rf: Run in floating terminal
local last_run_term = nil
vim.keymap.set('n', '<leader>rf', function()
    vim.cmd 'w'
    if last_run_term and last_run_term:buf_valid() then last_run_term:close() end
    local cmd, root = get_run_cmd()
    local height = math.floor(vim.o.lines * 0.6)
    last_run_term = _G.Snacks.terminal.open(cmd, {
        cwd = root,
        auto_close = false,
        win = {
            position = 'float',
            border = 'rounded',
            width = vim.o.columns,
            height = height,
            row = vim.o.lines - height - 2,
            col = 0,
            keys = { ['<C-c>'] = 'close' },
        },
    })
end, { desc = '[R]un [F]loat' })

-- pi integration
vim.keymap.set('x', '<leader><leader>', function() require('pi').send_selection() end, { desc = 'Send selection to pi' })
vim.keymap.set('n', '<leader>da', function() require('pi').send_diagnostics() end, { desc = '[D]iagnostic [A]sk pi' })
