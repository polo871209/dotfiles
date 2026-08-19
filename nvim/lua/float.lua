-- Floating replacements for the cmdline prompts. 'cmdheight' is 0, so the
-- native ones draw on a line the screen does not reserve.
--
-- `M.anchor` is shared with picker/core.lua's compact layout, so the vim.ui
-- select box and the vim.ui input box open at the same width and the same top
-- row: choosing a target and then typing at it should look like one box that
-- changed contents, not two unrelated windows.

local M = {}

local MIN_WIDTH = 40
local MAX_WIDTH = 80
local WIDTH_FRAC = 0.45
-- Well above centre: with a tall box the eye still lands near the middle, and
-- the text being asked about stays visible underneath.
local TOP_FRAC = 0.18
local MAX_INPUT_HEIGHT = 12

--- Width and position every centred prompt float shares.
---@return { width: integer, row: integer, col: integer }
function M.anchor()
    local width = math.max(1, math.min(math.floor(vim.o.columns * WIDTH_FRAC), MAX_WIDTH, vim.o.columns - 4))
    width = math.max(width, math.min(MIN_WIDTH, vim.o.columns - 4))
    return {
        width = width,
        row = math.max(0, math.floor((vim.o.lines - vim.o.cmdheight) * TOP_FRAC)),
        col = math.max(0, math.floor((vim.o.columns - width) / 2)),
    }
end

--- Centred multiline prompt. <CR> sends, <S-CR> opens a new line, and the box
--- grows with the text. `on_confirm` runs exactly once: with the typed text on
--- send, with nil on <Esc>, <C-c>, or leaving the window.
---@param opts { prompt: string?, default: string?, completion: string? }?
---@param on_confirm fun(input: string?)
function M.input(opts, on_confirm)
    opts = opts or {}
    local prompt = vim.trim((opts.prompt or 'Input'):gsub(':%s*$', ''))

    local buf = vim.api.nvim_create_buf(false, true)
    vim.bo[buf].buftype = 'nofile'
    vim.b[buf].completion = false -- blink.cmp reads this flag
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(opts.default or '', '\n'))

    local anchor = M.anchor()
    local win = vim.api.nvim_open_win(buf, true, {
        relative = 'editor',
        style = 'minimal',
        border = 'rounded',
        title = (' %s '):format(prompt),
        title_pos = 'center',
        width = anchor.width,
        height = math.min(vim.api.nvim_buf_line_count(buf), MAX_INPUT_HEIGHT),
        row = anchor.row,
        col = anchor.col,
        zindex = 60,
    })
    vim.wo[win].wrap = true

    local group = vim.api.nvim_create_augroup('float_input_' .. buf, { clear = true })
    local done = false

    ---@param value string?
    local function finish(value)
        if done then return end
        done = true
        pcall(vim.api.nvim_del_augroup_by_id, group)
        vim.cmd 'stopinsert'
        pcall(vim.api.nvim_win_close, win, true)
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
        -- Scheduled so the caller runs with the prompt already gone: it often
        -- opens another float, and nesting the two orphans this one.
        vim.schedule(function() on_confirm(value) end)
    end

    vim.api.nvim_create_autocmd({ 'BufLeave', 'WinLeave' }, {
        group = group,
        buffer = buf,
        callback = function() finish(nil) end,
    })
    vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, {
        group = group,
        buffer = buf,
        callback = function()
            if not vim.api.nvim_win_is_valid(win) then return end
            local height = math.max(1, math.min(vim.api.nvim_buf_line_count(buf), MAX_INPUT_HEIGHT))
            if height ~= vim.api.nvim_win_get_height(win) then vim.api.nvim_win_set_height(win, height) end
        end,
    })

    local function set(lhs, fn) vim.keymap.set({ 'i', 'n' }, lhs, fn, { buffer = buf, nowait = true }) end
    set('<CR>', function() finish(table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')) end)
    set('<S-CR>', function() vim.api.nvim_put({ '', '' }, 'c', false, true) end)
    set('<Esc>', function() finish(nil) end)
    set('<C-c>', function() finish(nil) end)

    if opts.completion then
        -- The whole line is the completion base, so replace from column 1.
        vim.keymap.set('i', '<Tab>', function()
            local matches = vim.fn.getcompletion(vim.api.nvim_get_current_line(), opts.completion)
            if #matches > 0 then vim.fn.complete(1, matches) end
        end, { buffer = buf, nowait = true })
    end

    vim.cmd 'startinsert!'
end

return M
