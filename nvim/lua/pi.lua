local M = {}

local TIMEOUT = 1000
local MAX_PAYLOAD = 900 * 1024

local VISUAL_MODES = { v = true, V = true, ['\22'] = true }

---@param msg string
---@param level? integer
local function notify(msg, level)
    vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

---@type string[]?
local bridge_socket_dirs_cache

---@return string[]
local function bridge_socket_dirs()
    if bridge_socket_dirs_cache then return bridge_socket_dirs_cache end
    local seen, out = {}, {}
    local function add(dir)
        if not dir or dir == '' then return end
        dir = dir:gsub('/+$', '')
        if not seen[dir] then
            seen[dir] = true
            table.insert(out, dir)
        end
    end
    add(vim.env.TMPDIR)
    local r = vim.system({ 'getconf', 'DARWIN_USER_TEMP_DIR' }, { text = true, timeout = TIMEOUT }):wait()
    if r.code == 0 and r.stdout then add(vim.trim(r.stdout)) end
    add '/tmp'
    bridge_socket_dirs_cache = out
    return out
end

---@param sock string
---@return boolean
local function listener_alive(sock)
    local pipe = vim.uv.new_pipe(false)
    if not pipe then return false end
    local ok, done = false, false
    pipe:connect(sock, function(err)
        ok = err == nil
        done = true
    end)
    vim.wait(150, function() return done end, 10)
    pcall(function() pipe:close() end)
    return ok
end

---@param pane_id string
---@return string[]
local function sockets_for_pane(pane_id)
    local safe = pane_id:gsub('[^%w_%-]', '_')
    local found = {}
    for _, dir in ipairs(bridge_socket_dirs()) do
        for _, sock in ipairs(vim.fn.glob(('%s/pi-tmux-pane-%s-*.sock'):format(dir, safe), true, true)) do
            if listener_alive(sock) then table.insert(found, sock) end
        end
    end
    return found
end

---@return table[] { pane_id, sock, window, label }
local function live_bridges()
    local fmt = '#{pane_id}\t#{window_index}\t#{window_name}'
    local r = vim.system({ 'tmux', 'list-panes', '-s', '-F', fmt }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return {} end
    local out = {}
    for line in r.stdout:gmatch '[^\n]+' do
        local pane_id, window, label = line:match '^([^\t]*)\t([^\t]*)\t(.*)$'
        if pane_id then
            for _, sock in ipairs(sockets_for_pane(pane_id)) do
                table.insert(out, { pane_id = pane_id, sock = sock, window = window, label = label })
            end
        end
    end
    return out
end

---@param cb fun(target: table?)
local function resolve_target(cb)
    if vim.env.TMUX == nil then
        notify('pi integration requires tmux', vim.log.levels.ERROR)
        return cb(nil)
    end
    local live = live_bridges()
    if #live == 0 then
        notify('No pi listener in this tmux session. Is tmux-bridge.ts loaded?', vim.log.levels.ERROR)
        return cb(nil)
    end
    if #live == 1 then return cb(live[1]) end
    vim.ui.select(live, {
        prompt = 'Send to which pi agent?',
        format_item = function(p) return ('%s %s'):format(p.window, p.label) end,
    }, function(choice) cb(choice) end)
end

---@param pane_id string
local function focus_pane(pane_id)
    vim.system({ 'tmux', 'switch-client', '-t', pane_id }, { timeout = TIMEOUT })
    vim.system({ 'tmux', 'select-pane', '-t', pane_id }, { timeout = TIMEOUT })
end

---@param sock string
---@param obj table
---@param on_ack? fun(ok: boolean, info: string)
local function send(sock, obj, on_ack)
    local function fail(info)
        notify('pi: ' .. info, vim.log.levels.ERROR)
        if on_ack then on_ack(false, info) end
    end
    local ok_encode, payload = pcall(vim.json.encode, obj)
    if not ok_encode then return fail 'could not encode payload' end
    if #payload > MAX_PAYLOAD then return fail 'payload too large' end

    local pipe = vim.uv.new_pipe(false)
    if not pipe then return fail 'could not open pipe' end
    local timer = vim.uv.new_timer()
    if not timer then
        pipe:close()
        return fail 'could not open timer'
    end
    local finished = false

    local function finish(ok, info)
        if finished then return end
        finished = true
        pcall(function() timer:close() end)
        pcall(function()
            if not pipe:is_closing() then pipe:close() end
        end)
        if ok then
            notify('pi: ' .. info)
        else
            notify('pi: ' .. info, vim.log.levels.ERROR)
        end
        if on_ack then on_ack(ok, info) end
    end

    timer:start(TIMEOUT * 3, 0, function() finish(false, 'timed out waiting for pi') end)
    pipe:connect(sock, function(cerr)
        if cerr then return finish(false, 'connect failed: ' .. cerr) end
        pipe:write(payload .. '\n', function(werr)
            if werr then return finish(false, 'write failed: ' .. werr) end
            local buf = ''
            pipe:read_start(function(rerr, chunk)
                if rerr then return finish(false, 'read failed: ' .. rerr) end
                if not chunk then return finish(false, 'pi closed the connection without acknowledging') end
                buf = buf .. chunk
                local line = buf:match '^(.-)\n'
                if not line then return end
                local ok_decode, ack = pcall(vim.json.decode, line)
                if not ok_decode or type(ack) ~= 'table' then return finish(false, 'unreadable reply from pi') end
                finish(ack.ok == true, ack.ok and (ack.delivered or 'delivered') or (ack.error or 'rejected'))
            end)
        end)
    end)
end

--- Line range of the current selection. Reads the live visual positions
--- instead of the `'<`/`'>` marks: a `<Cmd>` mapping (which is how
--- vim.keymap.set invokes a Lua callback) does not leave visual mode, so those
--- marks still describe the *previous* selection when the callback runs.
---@return integer?, integer?
local function selection_range()
    if VISUAL_MODES[vim.fn.mode()] then
        local anchor = vim.fn.getpos('v')[2]
        local cursor = vim.fn.getpos('.')[2]
        return math.min(anchor, cursor), math.max(anchor, cursor)
    end
    local s = vim.api.nvim_buf_get_mark(0, '<')[1]
    local e = vim.api.nvim_buf_get_mark(0, '>')[1]
    if s == 0 or e == 0 then return nil end
    return math.min(s, e), math.max(s, e)
end

--- Leave visual mode after the callback returns; feedkeys with 'x' inside a
--- `<Cmd>` mapping races against the mapping itself.
local function leave_visual()
    if not VISUAL_MODES[vim.fn.mode()] then return end
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<esc>', true, false, true), 'n', false)
end

function M.send_selection()
    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then
        leave_visual()
        return notify('Buffer has no file', vim.log.levels.WARN)
    end

    local sline, eline = selection_range()
    leave_visual()
    if not sline or not eline then return notify('No visual selection', vim.log.levels.WARN) end

    local filepath = vim.fn.fnamemodify(bufname, ':p')
    local ft = vim.bo[buf].filetype or ''
    local total = vim.api.nvim_buf_line_count(buf)
    eline = math.min(eline, total)

    resolve_target(function(target)
        if not target then return end
        local selected = table.concat(vim.api.nvim_buf_get_lines(buf, sline - 1, eline, false), '\n')
        if #selected <= MAX_PAYLOAD / 2 then
            send(target.sock, { file = { path = filepath, sline = sline, eline = eline, ft = ft, content = selected, total = total } })
        else
            send(target.sock, { paste = ('Re: %s lines %d-%d. Read the file for full context.'):format(filepath, sline, eline) })
        end
        focus_pane(target.pane_id)
    end)
end

--- The pi listeners in this tmux session, in tmux pane order.
---@return { sock: string, window: string, label: string }[]?, string? error when there is no list
function M.listeners()
    if vim.env.TMUX == nil then return nil, 'nvim does not run inside tmux' end
    local live = live_bridges()
    if #live == 0 then return nil, 'no pi listener in this tmux session' end
    return vim.tbl_map(function(p) return { sock = p.sock, window = p.window, label = p.label } end, live)
end

--- Sends a review comment on a file range to the pi listening on `sock`: the line-numbered
--- snapshot of the range, then `comment` as a user message, which starts a turn or steers
--- the running one. `on_done` runs on the main loop with pi's answer to the last request.
---@param sock string
---@param file { path: string, sline: integer, eline: integer, ft: string, content: string, total: integer }
---@param comment string
---@param on_done fun(ok: boolean, info: string)
function M.send_comment(sock, file, comment, on_done)
    local done = vim.schedule_wrap(on_done)
    send(sock, { file = file, mode = 'steer' }, function(ok, info)
        if not ok then return done(false, info) end
        send(sock, { text = comment }, done)
    end)
end

function M.send_diagnostics()
    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then return notify('Buffer has no file', vim.log.levels.WARN) end

    local diagnostics = vim.diagnostic.get(buf)
    if #diagnostics == 0 then return notify('No diagnostics in current buffer', vim.log.levels.WARN) end

    local severity_names = {
        [vim.diagnostic.severity.ERROR] = 'ERROR',
        [vim.diagnostic.severity.WARN] = 'WARNING',
        [vim.diagnostic.severity.INFO] = 'INFO',
        [vim.diagnostic.severity.HINT] = 'HINT',
    }

    local lines = {}
    for _, d in ipairs(diagnostics) do
        local severity = severity_names[d.severity] or 'UNKNOWN'
        table.insert(lines, ('[%s] Line %d: %s'):format(severity, d.lnum + 1, (d.message or ''):gsub('\n', ' ')))
    end

    local filepath = vim.fn.fnamemodify(bufname, ':p')
    local text = 'Please review these diagnostics and help me fix them.\n\n' .. filepath .. ':\n' .. table.concat(lines, '\n')

    resolve_target(function(target)
        if not target then return end
        send(target.sock, { text = text })
        focus_pane(target.pane_id)
    end)
end

return M
