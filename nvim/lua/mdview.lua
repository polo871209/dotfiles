-- Streams the current markdown buffer to the native viewer in `mdview/`. The first toggle builds it.

local M = {}

local DIR = vim.fn.stdpath 'config' .. '/mdview'
local BIN = DIR .. '/.build/release/mdview'
-- Coalesces a burst of keystrokes into one render.
local DEBOUNCE_MS = 80

---@type { proc: vim.SystemObj, buf: integer, timer: uv.uv_timer_t, group: integer }?
local state

local function send()
    if not state or not vim.api.nvim_buf_is_valid(state.buf) then return end
    local buf = state.buf
    local name = vim.api.nvim_buf_get_name(buf)
    local line = 1
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do
        line = vim.api.nvim_win_get_cursor(win)[1]
        if win == vim.api.nvim_get_current_win() then break end
    end
    state.proc:write(vim.json.encode {
        path = name ~= '' and name or vim.fn.getcwd() .. '/[No Name].md',
        text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n'),
        line = line,
    } .. '\n')
end

local function schedule_send()
    if not state then return end
    state.timer:stop()
    state.timer:start(DEBOUNCE_MS, 0, vim.schedule_wrap(send))
end

local function stop()
    if not state then return end
    local s = state
    state = nil
    vim.api.nvim_del_augroup_by_id(s.group)
    s.timer:close()
    if not s.proc:is_closing() then s.proc:kill 'sigterm' end
end

--- A link clicked in the viewer. The BufEnter autocmd then sends the file back if it is markdown.
---@param msg { open: string, anchor: string? }
local function follow(msg)
    if not vim.uv.fs_stat(msg.open) then return vim.notify('mdview: no such file: ' .. msg.open, vim.log.levels.WARN) end
    -- Open where the previewed buffer is shown, not in whatever window has focus (a picker, the tree).
    local win = state and vim.fn.win_findbuf(state.buf)[1] or 0
    vim.api.nvim_win_call(win, function()
        local ok, err = pcall(vim.cmd.edit, vim.fn.fnameescape(msg.open))
        if not ok then return vim.notify(err, vim.log.levels.ERROR) end
        -- GitHub-style `file#L42`. A heading anchor is handled in the viewer.
        local line = tonumber((msg.anchor or ''):match '^L(%d+)')
        if line then pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 }) end
    end)
end

local function start(buf)
    local stderr, stdout = {}, ''
    local proc ---@type vim.SystemObj
    proc = vim.system({ BIN }, {
        stdin = true,
        stderr = function(_, data) table.insert(stderr, data) end,
        stdout = function(_, data)
            stdout = stdout .. (data or '')
            for line in stdout:gmatch '([^\n]*)\n' do
                local ok, msg = pcall(vim.json.decode, line)
                if ok then vim.schedule(function() follow(msg) end) end
            end
            stdout = stdout:match '[^\n]*$'
        end,
    }, function()
        vim.schedule(function()
            -- The window closing ends the process, so this is the normal exit path too.
            if state and state.proc == proc then stop() end
            local err = vim.trim(table.concat(stderr))
            if err ~= '' then vim.notify(err, vim.log.levels.WARN) end
        end)
    end)
    local group = vim.api.nvim_create_augroup('mdview', { clear = true })
    state = { proc = proc, buf = buf, timer = assert(vim.uv.new_timer()), group = group }

    vim.api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'TextChangedP' }, {
        group = group,
        callback = function(args)
            if args.buf == state.buf then schedule_send() end
        end,
    })
    -- The window follows whichever markdown buffer has focus.
    vim.api.nvim_create_autocmd('BufEnter', {
        group = group,
        callback = function(args)
            if vim.bo[args.buf].filetype ~= 'markdown' or args.buf == state.buf then return end
            state.buf = args.buf
            schedule_send()
        end,
    })
    send()
end

local building = false

--- Open the viewer on `buf`, or close it when it is already open.
---@param buf integer?
function M.toggle(buf)
    if state then return stop() end
    buf = buf or vim.api.nvim_get_current_buf()
    if vim.uv.fs_stat(BIN) then return start(buf) end
    if building then return end
    -- First use on this machine. `just` in DIR runs the default recipe of nvim/mdview/justfile.
    building = true
    vim.notify 'mdview: building the viewer, about a minute on first use'
    local ok, err = pcall(vim.system, { 'just' }, { cwd = DIR, text = true }, function(out)
        vim.schedule(function()
            building = false
            if out.code ~= 0 then return vim.notify('mdview: build failed\n' .. out.stderr, vim.log.levels.ERROR) end
            if vim.api.nvim_buf_is_valid(buf) then start(buf) end
        end)
    end)
    if not ok then
        building = false
        vim.notify('mdview: cannot run `just`: ' .. err, vim.log.levels.ERROR)
    end
end

return M
