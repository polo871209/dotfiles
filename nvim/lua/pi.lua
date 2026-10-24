local M = {}

local TIMEOUT = 1000
local MAX_PAYLOAD = 900 * 1024

local VISUAL_MODES = { v = true, V = true, ['\22'] = true }

---@param msg string
---@param level? integer
local function notify(msg, level)
    vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

---@param args string[]
---@return table?
local function rex(args)
    local r = vim.system({ 'rex', unpack(args) }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return nil end
    local ok, out = pcall(vim.json.decode, r.stdout)
    return ok and out or nil
end

---@param block_id string
---@return string
local function socket_for_block(block_id) return vim.fs.joinpath(vim.uv.os_tmpdir(), ('pi-%s.sock'):format((block_id:gsub('^block:', '')))) end

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

---@return { block_id: string, window_id: string, sock: string, window: string, label: string }[]
local function live_bridges()
    local session = vim.env.REX_SESSION
    local layout = rex { 'window', 'ls', '-s', session, '--json' }
    if not layout then return {} end
    local out = {}
    for index, window in ipairs(layout.windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                local sock = socket_for_block(block.block_id)
                if vim.uv.fs_stat(sock) and listener_alive(sock) then
                    local title = rex { 'block', 'call', '-s', session, '-b', block.block_id, 'title' }
                    table.insert(out, {
                        block_id = block.block_id,
                        window_id = window.window_id,
                        sock = sock,
                        window = tostring(index),
                        label = title and title.title or window.label,
                    })
                end
            end
        end
    end
    return out
end

---@param cb fun(target: table?)
local function resolve_target(cb)
    if vim.env.REX_SESSION == nil then
        notify('pi integration requires Rex', vim.log.levels.ERROR)
        return cb(nil)
    end
    local live = live_bridges()
    if #live == 0 then
        notify('No pi listener in this Rex session. Is rex-bridge.ts loaded?', vim.log.levels.ERROR)
        return cb(nil)
    end
    if #live == 1 then return cb(live[1]) end
    vim.ui.select(live, {
        prompt = 'Send to which pi agent?',
        format_item = function(p) return ('%s %s'):format(p.window, p.label) end,
    }, function(choice) cb(choice) end)
end

---@param args string[]
---@param on_ok? fun()
local function rex_async(args, on_ok)
    vim.system({ 'rex', unpack(args) }, { text = true, timeout = TIMEOUT }, function(r)
        if r.code ~= 0 then return notify(('pi: rex %s failed: %s'):format(args[1], vim.trim(r.stderr or '')), vim.log.levels.WARN) end
        if on_ok then on_ok() end
    end)
end

-- The Rex app keeps its own visible tab per client, so `rex focus` alone leaves the app on the old tab.
---@param target { block_id: string, window_id: string }
local function show_target(target)
    local session = vim.env.REX_SESSION
    rex_async(
        { 'focus', '-s', session, target.block_id },
        function() rex_async { 'do', 'session.select', 'session_id=' .. session, 'window_id=' .. target.window_id } end
    )
end

---@param sock string
---@param obj table
---@param on_reply fun(ack: table?, err: string?)
local function request(sock, obj, on_reply)
    local ok_encode, payload = pcall(vim.json.encode, obj)
    if not ok_encode then return on_reply(nil, 'could not encode payload') end
    if #payload > MAX_PAYLOAD then return on_reply(nil, 'payload too large') end

    local pipe = vim.uv.new_pipe(false)
    if not pipe then return on_reply(nil, 'could not open pipe') end
    local timer = vim.uv.new_timer()
    if not timer then
        pipe:close()
        return on_reply(nil, 'could not open timer')
    end
    local finished = false

    local function finish(ack, err)
        if finished then return end
        finished = true
        pcall(function() timer:close() end)
        pcall(function()
            if not pipe:is_closing() then pipe:close() end
        end)
        on_reply(ack, err)
    end

    timer:start(TIMEOUT * 3, 0, function() finish(nil, 'timed out waiting for pi') end)
    pipe:connect(sock, function(cerr)
        if cerr then return finish(nil, 'connect failed: ' .. cerr) end
        pipe:write(payload .. '\n', function(werr)
            if werr then return finish(nil, 'write failed: ' .. werr) end
            local buf = ''
            pipe:read_start(function(rerr, chunk)
                if rerr then return finish(nil, 'read failed: ' .. rerr) end
                if not chunk then return finish(nil, 'pi closed the connection without acknowledging') end
                buf = buf .. chunk
                local line = buf:match '^(.-)\n'
                if not line then return end
                local ok_decode, ack = pcall(vim.json.decode, line)
                if not ok_decode or type(ack) ~= 'table' then return finish(nil, 'unreadable reply from pi') end
                finish(ack)
            end)
        end)
    end)
end

---@param sock string
---@param obj table
---@param on_ack? fun(ok: boolean, info: string)
local function send(sock, obj, on_ack)
    request(sock, obj, function(ack, err)
        local ok = ack ~= nil and ack.ok == true
        local info = err or (ok and (ack.delivered or 'delivered') or (ack.error or 'rejected'))
        notify('pi: ' .. info, not ok and vim.log.levels.ERROR or nil)
        if on_ack then on_ack(ok, info) end
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
        show_target(target)
    end)
end

---@return { sock: string, window: string, label: string }[]?, string? error when there is no list
function M.listeners()
    if vim.env.REX_SESSION == nil then return nil, 'nvim does not run inside Rex' end
    local live = live_bridges()
    if #live == 0 then return nil, 'no pi listener in this Rex session' end
    return vim.tbl_map(function(p) return { sock = p.sock, window = p.window, label = p.label } end, live)
end

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

---@param block_id string
function M.open_last_edit(block_id)
    local path, replied = nil, false
    request(socket_for_block(block_id), { query = 'last_edit' }, function(ack)
        path = ack and ack.ok and ack.path
        replied = true
    end)
    vim.wait(TIMEOUT, function() return replied end, 5)
    if path then vim.cmd.edit(vim.fn.fnameescape(path)) end
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
        show_target(target)
    end)
end

return M
