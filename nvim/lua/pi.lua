-- Send selections / diagnostics from neovim to a pi instance running in the
-- same tmux session. Requires .pi/agent/extensions/tmux-bridge.ts to be loaded
-- in pi, which listens on $TMPDIR/pi-tmux-pane-<pane>-<pid>.sock. Multiple pi
-- panes in the session -> vim.ui.select to pick one.
local M = {}

local TIMEOUT = 1000
-- Bridge drops a connection whose buffered line exceeds 2 MiB; stay under it
-- with room for JSON escaping, which can nearly double a pathological file.
local MAX_PAYLOAD = 900 * 1024

local VISUAL_MODES = { v = true, V = true, ['\22'] = true }

---@param msg string
---@param level? integer
local function notify(msg, level)
    vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

--- Directories that may hold bridge sockets. pi uses Node's `os.tmpdir()`,
--- which on macOS is the per-user /var/folders path regardless of $TMPDIR, so
--- nvim's own $TMPDIR is not enough. Cached: `getconf` is a process spawn and
--- the answer never changes within a session.
---@type string[]?
local temp_dirs_cache

---@return string[]
local function temp_dirs()
    if temp_dirs_cache then return temp_dirs_cache end
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
    temp_dirs_cache = out
    return out
end

--- Check whether a unix socket has a live listener by attempting a connect.
--- Blocks up to ~150ms; a crashed pi leaves the socket file behind, so file
--- existence alone proves nothing.
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

--- Live bridge sockets for one pane. The socket name carries pi's pid, so a
--- pane that reused an id after a crash can expose several candidates.
---@param pane_id string
---@return string[]
local function sockets_for_pane(pane_id)
    local safe = pane_id:gsub('[^%w_%-]', '_')
    local found = {}
    for _, dir in ipairs(temp_dirs()) do
        for _, sock in ipairs(vim.fn.glob(('%s/pi-tmux-pane-%s-*.sock'):format(dir, safe), true, true)) do
            if listener_alive(sock) then table.insert(found, sock) end
        end
    end
    return found
end

--- Every pane of the current tmux session that answers on a bridge socket.
--- Panes are probed by socket rather than by pane title or
--- pane_current_command: pi runs as "node", and its title is decoration that
--- changes with session state, so neither identifies it reliably.
---@return table[] { pane_id, sock, window_index, window_name }
local function live_bridges()
    local fmt = '#{pane_id}\t#{window_index}\t#{window_name}'
    local r = vim.system({ 'tmux', 'list-panes', '-s', '-F', fmt }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return {} end
    local out = {}
    for line in r.stdout:gmatch '[^\n]+' do
        local pane_id, window_index, window_name = line:match '^([^\t]*)\t([^\t]*)\t(.*)$'
        if pane_id then
            for _, sock in ipairs(sockets_for_pane(pane_id)) do
                table.insert(out, { pane_id = pane_id, sock = sock, window_index = window_index, window_name = window_name })
            end
        end
    end
    return out
end

--- Resolve which pi to send to: the session's only live bridge, or a
--- vim.ui.select prompt when there are several.
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
    -- Labelled with the tmux window index, which is what the status line shows
    -- and the only thing distinguishing two panes with the same title.
    vim.ui.select(live, {
        prompt = 'Send to which pi agent?',
        format_item = function(p) return ('%s  %s'):format(p.window_index, p.window_name) end,
    }, function(choice) cb(choice) end)
end

--- Bring a tmux pane into view for the attached client, best effort/async.
---@param pane_id string
local function focus_pane(pane_id)
    -- switch-client moves the client to the pane's session/window; select-pane
    -- then makes it active within that window if it wasn't already.
    vim.system({ 'tmux', 'switch-client', '-t', pane_id }, { timeout = TIMEOUT })
    vim.system({ 'tmux', 'select-pane', '-t', pane_id }, { timeout = TIMEOUT })
end

--- Send one JSON line and report what the bridge did with it. Written over a
--- raw uv pipe rather than `nc`: nc has no delivery signal, and killing it on
--- a timeout truncated large payloads into JSON the bridge silently dropped.
---@param sock string
---@param obj table
---@param on_ack? fun(ok: boolean, info: string)
local function send(sock, obj, on_ack)
    local ok_encode, payload = pcall(vim.json.encode, obj)
    if not ok_encode then return notify('pi: could not encode payload', vim.log.levels.ERROR) end
    if #payload > MAX_PAYLOAD then return notify('pi: payload too large', vim.log.levels.ERROR) end

    local pipe = vim.uv.new_pipe(false)
    if not pipe then return notify('pi: could not open pipe', vim.log.levels.ERROR) end
    local timer = vim.uv.new_timer()
    if not timer then
        pipe:close()
        return notify('pi: could not open timer', vim.log.levels.ERROR)
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
    -- Re-invoked from normal mode or `:'<,'>lua`: marks are the only source.
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

    -- Absolute: pi's cwd is not necessarily nvim's, and the bridge shortens
    -- the path for display on its own side.
    local filepath = vim.fn.fnamemodify(bufname, ':p')
    local ft = vim.bo[buf].filetype or ''
    local total = vim.api.nvim_buf_line_count(buf)
    eline = math.min(eline, total)

    resolve_target(function(target)
        if not target then return end
        -- Drop the snapshot into pi rather than prompting here: vim.ui.input
        -- has no slash-commands or completion, pi's own editor does. The bridge
        -- pastes it into that editor, so it becomes part of the prompt you
        -- send, after your question. Only the selected lines go over: whole-file
        -- payloads buried the actual question in unrelated context, and pi's
        -- edit/write read from disk at exec time, so it can pull the rest itself
        -- when it needs it. `total` only sizes the gutter and names what was
        -- omitted.
        local selected = table.concat(vim.api.nvim_buf_get_lines(buf, sline - 1, eline, false), '\n')
        if #selected <= MAX_PAYLOAD / 2 then
            send(target.sock, { file = { path = filepath, sline = sline, eline = eline, ft = ft, content = selected, total = total } })
        else
            send(target.sock, { paste = ('Re: %s lines %d-%d. Read the file for full context.'):format(filepath, sline, eline) })
        end
        focus_pane(target.pane_id)
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
