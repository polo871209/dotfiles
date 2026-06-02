-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

vim.pack.add { 'https://github.com/folke/snacks.nvim' }

local ignore = require 'ignore'
local snacks = require 'snacks'

snacks.setup {
    bigfile = {},
    indent = {},
    input = {},
    lazygit = {
        configure = false,
        win = { style = 'lazygit' },
    },
    picker = {
        layout = { fullscreen = true, preset = 'telescope' },
        formatters = {
            file = {
                min_width = 999,
            },
        },
        exclude = ignore.patterns,
        sources = {
            smart = {
                filter = { cwd = true },
            },
            files = {
                hidden = true,
            },
        },
    },
    gitbrowse = {
        remote_patterns = {
            { '^git@github%.com%-[^:]+:(.+)%.git$', 'https://github.com/%1' },
            { '^git@github%.com%-[^:]+:(.+)$', 'https://github.com/%1' },
            { '^(https?://.*)%.git$', '%1' },
            { '^git@(.+):(.+)%.git$', 'https://%1/%2' },
            { '%.git$', '' },
        },
    },
    styles = {
        lazygit = { width = 0.99, height = 0.99 },
    },
    notifier = {
        level = vim.log.levels.INFO,
    },
    toggle = {},
    words = {},
}

-- Picker keymaps
vim.keymap.set('n', '<leader><space>', function() snacks.picker.smart() end, { desc = 'Smart Find Files' })
vim.keymap.set('n', '<leader>sg', function() snacks.picker.grep { hidden = true, no_ignore = true } end, { desc = 'Grep' })
vim.keymap.set('n', '<leader>/', function() snacks.picker.grep_buffers() end, { desc = 'Grep Open Buffers' })
vim.keymap.set('n', '<leader>sn', function() snacks.picker.notifications() end, { desc = 'Notification History' })
vim.keymap.set('n', '<leader>sk', function() snacks.picker.keymaps() end, { desc = 'Keymaps' })
vim.keymap.set('n', '<leader>ss', function() snacks.picker.spelling() end, { desc = 'Spelling' })

-- LSP pickers
vim.keymap.set('n', 'gd', function() snacks.picker.lsp_definitions() end, { desc = 'Goto Definition' })
vim.keymap.set('n', 'gD', function() snacks.picker.lsp_declarations() end, { desc = 'Goto Declaration' })
vim.keymap.set('n', 'gr', function() snacks.picker.lsp_references() end, { nowait = true, desc = 'References' })
vim.keymap.set('n', 'gI', function() snacks.picker.lsp_implementations() end, { desc = 'Goto Implementation' })
vim.keymap.set('n', 'gy', function() snacks.picker.lsp_type_definitions() end, { desc = 'Goto T[y]pe Definition' })

-- gf follows links/files under the cursor and pushes the tagstack so <C-t>
-- jumps back: file://...#Lnnn doc-links (e.g. ZLS hover -> std source) read
-- straight out of the hover float, and plain/relative paths via native gF.
local function push_tag()
    local win = vim.api.nvim_get_current_win()
    local pos = vim.api.nvim_win_get_cursor(win)
    local from = { vim.api.nvim_get_current_buf(), pos[1], pos[2] + 1, 0 }
    vim.fn.settagstack(win, { items = { { tagname = vim.fn.expand '<cword>', from = from } } }, 't')
end

local function follow_file_link(text)
    local url = text:match 'file://([^%s)%]>"\']+)'
    if not url then return false end
    local path, lnum = url:match '^(.-)#L(%d+)$'
    push_tag()
    vim.cmd.edit(vim.uri_decode(path or url))
    if lnum then pcall(vim.api.nvim_win_set_cursor, 0, { tonumber(lnum), 0 }) end
    return true
end

vim.keymap.set('n', 'gf', function()
    -- 1. file:// link inside the open hover float (no need to enter it)
    local fwin = vim.b.lsp_floating_preview
    if fwin and vim.api.nvim_win_is_valid(fwin) then
        local text = table.concat(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(fwin), 0, -1, false), '\n')
        if text:match 'file://' then
            vim.api.nvim_win_close(fwin, true)
            vim.b.lsp_floating_preview = nil
            if follow_file_link(text) then return end
        end
    end
    -- 2. file:// link on the current line
    if follow_file_link(vim.api.nvim_get_current_line()) then return end
    -- 3. plain/relative file under cursor (gF honors a trailing :line). Push
    --    the tagstack, rolling back if gF can't open anything.
    local win = vim.api.nvim_get_current_win()
    local saved = vim.fn.gettagstack(win)
    push_tag()
    if not pcall(function() vim.cmd 'normal! gF' end) then
        vim.fn.settagstack(win, saved, 'r')
        vim.cmd 'normal! gf' -- surface the native "can't find file" error
    end
end, { desc = 'Follow link / file under cursor' })

-- Git keymaps
vim.keymap.set('n', '<leader>lg', function() snacks.lazygit() end, { desc = '[L]azy[g]it' })
vim.keymap.set('n', '<leader>gb', function() snacks.git.blame_line() end, { desc = '[G]it [B]lame Line' })
vim.keymap.set('n', '<leader>gB', function() snacks.gitbrowse() end, { desc = '[G]it [B]rowse' })
vim.keymap.set('n', '<leader>tn', function() snacks.notifier.hide() end, { desc = 'Dismiss All [N]otifications' })

-- Toggle mappings (deferred so Snacks global is fully initialized)
vim.schedule(function()
    snacks.toggle.option('wrap', { name = 'Wrap' }):map '<leader>tw'
    snacks.toggle.diagnostics():map '<leader>td'
end)
