-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

local ignore = require 'ignore'

-- Resize neo-tree window to fit the longest visible node.
local function fit()
    local state = require('neo-tree.sources.manager').get_state 'filesystem'
    if not state or not state.tree or not state.winid then return end
    if not vim.api.nvim_win_is_valid(state.winid) then return end
    local cap = math.floor(vim.o.columns * 0.5)
    local max = 18
    local function visit(node)
        local w = (node.level or 0) * 2 + 7 + vim.fn.strdisplaywidth(node.name or '')
        if w > max then max = w end
        if node:is_expanded() then
            for _, id in ipairs(node:get_child_ids() or {}) do
                local c = state.tree:get_node(id)
                if c then visit(c) end
            end
        end
    end
    for _, n in ipairs(state.tree:get_nodes() or {}) do
        visit(n)
    end
    max = math.min(max, cap)
    if vim.api.nvim_win_get_width(state.winid) ~= max then vim.api.nvim_win_set_width(state.winid, max) end
end

local loaded = false
local function load_neotree()
    if loaded then return end
    loaded = true

    vim.pack.add {
        'https://github.com/nvim-lua/plenary.nvim',
        'https://github.com/nvim-tree/nvim-web-devicons',
        'https://github.com/MunifTanjim/nui.nvim',
        'https://github.com/nvim-neo-tree/neo-tree.nvim',
    }

    require('neo-tree').setup {
        default_component_configs = {
            file_size = { enabled = false },
            type = { enabled = false },
            last_modified = { enabled = false },
            created = { enabled = false },
            symlink_target = { enabled = false },
            -- Right-aligned columns pad lines to window width and break our auto-resize.
            diagnostics = { align = 'left' },
            git_status = { align = 'left' },
        },
        filesystem = {
            filtered_items = {
                visible = false,
                show_hidden_count = false,
                hide_dotfiles = false,
                hide_by_name = ignore.names,
            },
            window = {
                width = 30,
                mappings = {
                    ['\\'] = 'close_window',
                    ['<Right>'] = 'open',
                    ['<Left>'] = 'close_node',
                },
            },
        },
        event_handlers = {
            {
                event = 'file_opened',
                handler = function() require('neo-tree.command').execute { action = 'close' } end,
            },
            {
                event = 'neo_tree_buffer_enter',
                handler = function()
                    vim.schedule(fit)
                    vim.api.nvim_create_autocmd('CursorMoved', { buffer = 0, callback = vim.schedule_wrap(fit) })
                end,
            },
            {
                event = 'after_render',
                handler = function() vim.schedule(fit) end,
            },
        },
    }
end

vim.keymap.set('n', '\\', function()
    load_neotree()
    local bufname = vim.api.nvim_buf_get_name(0)
    if bufname == '' or vim.bo.filetype == 'ministarter' or vim.bo.buftype ~= '' then
        vim.cmd 'Neotree toggle'
    else
        vim.cmd 'Neotree reveal'
    end
end, { desc = 'NeoTree toggle/reveal', silent = true })
