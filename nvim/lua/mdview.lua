local M = {}

M.TOGGLE = '<leader>tm'

local DIR = vim.fn.stdpath 'config' .. '/mdview'
local BIN = DIR .. '/.build/release/mdview'
local DEBOUNCE_MS = 80

---@type { proc: vim.SystemObj, buf: integer, timer: uv.uv_timer_t, group: integer, scrolled: integer? }?
local state

---@param buf integer
local function path(buf)
    local name = vim.api.nvim_buf_get_name(buf)
    return name ~= '' and name or vim.fn.getcwd() .. '/[No Name].md'
end

---@param buf integer
---@return integer?
local function window(buf)
    local wins = vim.fn.win_findbuf(buf)
    local current = vim.api.nvim_get_current_win()
    return vim.tbl_contains(wins, current) and current or wins[1]
end

local function send()
    if not state or not vim.api.nvim_buf_is_valid(state.buf) then return end
    local buf = state.buf
    local win = window(buf)
    state.proc:write(vim.json.encode {
        path = path(buf),
        text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n'),
        top = win and vim.fn.line('w0', win) or 1,
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

---@param msg { open: string, anchor: string? }
local function follow(msg)
    if not vim.uv.fs_stat(msg.open) then return vim.notify('mdview: no such file: ' .. msg.open, vim.log.levels.WARN) end
    local win = state and window(state.buf) or 0
    vim.api.nvim_win_call(win, function()
        local ok, err = pcall(vim.cmd.edit, vim.fn.fnameescape(msg.open))
        if not ok then return vim.notify(err, vim.log.levels.ERROR) end
        local line = tonumber((msg.anchor or ''):match '^L(%d+)')
        if line then pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 }) end
    end)
end

---@param reply table
local function to_viewer(reply)
    if state then state.proc:write(vim.json.encode(reply) .. '\n') end
end

---@param msg { comment: string, path: string, sline: integer, eline: integer, target: string? }
local function comment(msg)
    local function reply(ok, info) to_viewer { sent = ok, info = info } end
    if not state or path(state.buf) ~= msg.path or vim.api.nvim_buf_get_name(state.buf) == '' then return reply(false, 'the previewed buffer has no file') end
    local pi = require 'pi'
    local listeners, err = pi.listeners()
    if not listeners then return reply(false, err) end
    local wanted = msg.target or vim.b[state.buf].mdview_pi
    local chosen = #listeners == 1 and listeners[1] or nil
    for _, listener in ipairs(listeners) do
        if listener.sock == wanted then chosen = listener end
    end
    if not chosen then return to_viewer { choose = listeners } end
    vim.b[state.buf].mdview_pi = chosen.sock
    local lines = vim.api.nvim_buf_get_lines(state.buf, 0, -1, false)
    local eline = math.min(msg.eline, #lines)
    pi.send_comment(chosen.sock, {
        path = msg.path,
        sline = msg.sline,
        eline = eline,
        ft = vim.bo[state.buf].filetype,
        content = table.concat(lines, '\n', msg.sline, eline),
        total = #lines,
    }, msg.comment, reply)
end

---@param msg { path: string, top: integer }
local function scroll(msg)
    if not state or path(state.buf) ~= msg.path then return end
    local win = window(state.buf)
    if not win then return end
    vim.api.nvim_win_call(win, function()
        local delta = msg.top - vim.fn.line 'w0'
        if delta == 0 then return end
        state.scrolled = msg.top
        vim.cmd(('normal! %d%s'):format(math.abs(delta), delta > 0 and '\5' or '\25'))
    end)
end

local function start(buf)
    local stderr, stdout = {}, ''
    local proc ---@type vim.SystemObj
    proc = vim.system({ BIN, vim.keycode(M.TOGGLE) }, {
        stdin = true,
        stderr = function(_, data) table.insert(stderr, data) end,
        stdout = function(_, data)
            stdout = stdout .. (data or '')
            for line in stdout:gmatch '([^\n]*)\n' do
                local ok, msg = pcall(vim.json.decode, line)
                if ok then
                    vim.schedule(function()
                        if msg.comment then
                            comment(msg)
                        elseif msg.top then
                            scroll(msg)
                        else
                            follow(msg)
                        end
                    end)
                end
            end
            stdout = stdout:match '[^\n]*$'
        end,
    }, function()
        vim.schedule(function()
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
    vim.api.nvim_create_autocmd('WinScrolled', {
        group = group,
        callback = function(args)
            if args.buf ~= state.buf then return end
            local scrolled = state.scrolled
            state.scrolled = nil
            if vim.fn.line('w0', tonumber(args.match)) ~= scrolled then schedule_send() end
        end,
    })
    vim.api.nvim_create_autocmd('BufEnter', {
        group = group,
        callback = function(args)
            if not vim.tbl_contains({ 'markdown', 'html' }, vim.bo[args.buf].filetype) or args.buf == state.buf then return end
            state.buf = args.buf
            schedule_send()
        end,
    })
    send()
end

local building = false

---@param buf integer?
function M.toggle(buf)
    if state then return stop() end
    buf = buf or vim.api.nvim_get_current_buf()
    if vim.uv.fs_stat(BIN) then return start(buf) end
    if building then return end
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
