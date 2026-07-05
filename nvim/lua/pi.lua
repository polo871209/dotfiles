-- Send selections / diagnostics from neovim to a pi instance running in the
-- same tmux session. Requires .pi/extensions/tmux-bridge.ts to be loaded in
-- pi, which exposes a Unix socket per pi pane at
-- $TMPDIR/pi-tmux-pane-<sanitized-pane-id>.sock. Multiple pi panes in the
-- session -> vim.ui.select to pick one.
local M = {}

local TIMEOUT = 1000

---@param msg string
---@param level? integer
local function notify(msg, level)
    vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

--- Build candidate socket paths for a given tmux pane.
--- pi-side (tmux-bridge.ts) uses Node's `os.tmpdir()` which on macOS resolves
--- to /var/folders/.../T regardless of $TMPDIR. nvim's $TMPDIR may differ,
--- so we probe several candidates.
---@param pane_id string
---@return string[]
local function candidate_paths(pane_id)
    local safe = pane_id:gsub('[^%w_%-]', '_')
    local name = 'pi-tmux-pane-' .. safe .. '.sock'
    local seen, out = {}, {}
    local function add(dir)
        if not dir or dir == '' then return end
        dir = dir:gsub('/+$', '')
        local p = dir .. '/' .. name
        if not seen[p] then
            seen[p] = true
            table.insert(out, p)
        end
    end
    add(vim.env.TMPDIR)
    -- macOS canonical temp dir (matches Node's os.tmpdir() on Darwin).
    local r = vim.system({ 'getconf', 'DARWIN_USER_TEMP_DIR' }, { text = true, timeout = TIMEOUT }):wait()
    if r.code == 0 and r.stdout then add(vim.trim(r.stdout)) end
    add '/tmp'
    return out
end

--- Check whether a unix socket has a live listener by attempting a connect.
--- Fully synchronous, blocks up to ~150ms.
---@param sock string
---@return boolean
local function listener_alive(sock)
    if vim.uv.fs_stat(sock) == nil then return false end
    local pipe = vim.uv.new_pipe(false)
    if not pipe then return false end
    local ok = false
    local done = false
    pipe:connect(sock, function(err)
        ok = err == nil
        done = true
    end)
    vim.wait(150, function() return done end, 10)
    pcall(function() pipe:close() end)
    return ok
end

--- Resolve the live tmux-bridge socket for one pane, if any.
---@param pane_id string
---@return string?
local function socket_for_pane(pane_id)
    for _, p in ipairs(candidate_paths(pane_id)) do
        if listener_alive(p) then return p end
    end
    return nil
end

--- pi panes in the current tmux session. pi's own process shows up as "node"
--- in tmux (it's a node program), so we can't filter on
--- pane_current_command; pi sets its own pane title starting with "π" instead
--- (see notifier.ts / interactive-mode.updateTerminalTitle), which is what we
--- match on.
---@return table[]  { pane_id, window_name }
local function tmux_pi_panes()
    local r = vim.system({ 'tmux', 'list-panes', '-s', '-F', '#{pane_id}\t#{pane_title}\t#{window_name}' }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return {} end
    local out = {}
    for line in r.stdout:gmatch '[^\n]+' do
        local pane_id, pane_title, window_name = line:match '^([^\t]*)\t([^\t]*)\t(.*)$'
        if pane_title and pane_title:match '^π' then table.insert(out, { pane_id = pane_id, window_name = window_name }) end
    end
    return out
end

--- Resolve which pi socket to send to: the session's only live pi bridge, or
--- a vim.ui.select prompt when there are several.
---@param cb fun(sock: string?)
local function resolve_socket(cb)
    if vim.env.TMUX == nil then
        notify('pi integration requires tmux', vim.log.levels.ERROR)
        cb(nil)
        return
    end
    local live = {}
    for _, p in ipairs(tmux_pi_panes()) do
        local sock = socket_for_pane(p.pane_id)
        if sock then table.insert(live, { pane_id = p.pane_id, window_name = p.window_name, sock = sock }) end
    end
    if #live == 0 then
        notify('No pi listener found in this tmux session. Is .pi/extensions/tmux-bridge.ts loaded?', vim.log.levels.ERROR)
        cb(nil)
        return
    end
    if #live == 1 then
        cb(live[1].sock)
        return
    end
    vim.ui.select(live, {
        prompt = 'Send to which pi agent?',
        format_item = function(p) return p.window_name end,
    }, function(choice) cb(choice and choice.sock or nil) end)
end

--- Send a JSON object as one line to a pi socket. Fully async.
---@param sock string
---@param obj table
local function send(sock, obj)
    local payload = vim.json.encode(obj) .. '\n'
    vim.system({ 'nc', '-U', '-w', '1', sock }, { stdin = payload, text = true, timeout = TIMEOUT }, function(result)
        if result.code ~= 0 then
            notify('Failed to send to pi: ' .. (result.stderr or 'unknown error'), vim.log.levels.ERROR)
        else
            notify 'Sent to pi'
        end
    end)
end

--- Read selected text from the current buffer between marks `<` and `>`.
---@param buf integer
---@return string?, integer?, integer?
local function get_visual_selection(buf)
    local s = vim.api.nvim_buf_get_mark(buf, '<')
    local e = vim.api.nvim_buf_get_mark(buf, '>')
    if s[1] == 0 and e[1] == 0 then return nil end
    local lines = vim.api.nvim_buf_get_lines(buf, s[1] - 1, e[1], false)
    return table.concat(lines, '\n'), s[1], e[1]
end

function M.send_selection()
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<esc>', true, false, true), 'x', true)

    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then
        notify('Buffer has no file', vim.log.levels.WARN)
        return
    end

    local selection, sline, eline = get_visual_selection(buf)
    if not selection then
        notify('No visual selection', vim.log.levels.WARN)
        return
    end

    local filepath = vim.fn.fnamemodify(bufname, ':.')
    local ft = vim.bo[buf].filetype or ''

    resolve_socket(function(sock)
        if not sock then return end
        vim.ui.input({ prompt = 'pi: ' }, function(input)
            if not input or input == '' then return end
            -- Send the whole file so pi answers with zero extra read round-trip (pi's
            -- edit/write read from disk at exec time, so editing never needs a prior
            -- read either). The bridge injects it as a collapsed custom message so the
            -- conversation stays compact; the selection just marks the focus range.
            local all = table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
            -- tmux-bridge drops socket lines >256KB; for big files send a reference and
            -- let pi read them itself instead of the message being silently dropped.
            if #all <= 200000 then
                send(sock, { prompt = input, file = { path = filepath, sline = sline, eline = eline, ft = ft, content = all } })
            else
                send(sock, { text = string.format('%s\n\nRe: %s lines %d-%d. Read the file for full context.', input, filepath, sline, eline) })
            end
        end)
    end)
end

function M.send_diagnostics()
    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then
        notify('Buffer has no file', vim.log.levels.WARN)
        return
    end

    local diagnostics = vim.diagnostic.get(buf)
    if #diagnostics == 0 then
        notify('No diagnostics in current buffer', vim.log.levels.WARN)
        return
    end

    local severity_names = {
        [vim.diagnostic.severity.ERROR] = 'ERROR',
        [vim.diagnostic.severity.WARN] = 'WARNING',
        [vim.diagnostic.severity.INFO] = 'INFO',
        [vim.diagnostic.severity.HINT] = 'HINT',
    }

    local lines = {}
    for _, d in ipairs(diagnostics) do
        local severity = severity_names[d.severity] or 'UNKNOWN'
        table.insert(lines, string.format('[%s] Line %d: %s', severity, d.lnum + 1, (d.message or ''):gsub('\n', ' ')))
    end

    local filepath = vim.fn.fnamemodify(bufname, ':.')
    local text = 'Please review these diagnostics and help me fix them.\n\n' .. filepath .. ':\n' .. table.concat(lines, '\n')

    resolve_socket(function(sock)
        if sock then send(sock, { text = text }) end
    end)
end

return M
