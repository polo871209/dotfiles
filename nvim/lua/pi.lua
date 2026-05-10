-- Send selections / diagnostics from neovim to a pi instance running in the
-- same tmux session. Requires .pi/extensions/tmux-bridge.ts to be loaded in
-- pi, which exposes a Unix socket at $TMPDIR/pi-tmux-<session_id>.sock.
local M = {}

local TIMEOUT = 1000

---@param msg string
---@param level? integer
local function notify(msg, level)
  vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

--- Build candidate socket paths for the current tmux session.
--- pi-side (tmux-bridge.ts) uses Node's `os.tmpdir()` which on macOS resolves
--- to /var/folders/.../T regardless of $TMPDIR. nvim's $TMPDIR may differ,
--- so we probe several candidates.
---@param session_id string
---@return string[]
local function candidate_paths(session_id)
  local safe = session_id:gsub('[^%w_%-]', '_')
  -- Current layout (tmux-bridge.ts): <tmpdir>/pi-tmux-<safe>/bridge.sock
  -- Legacy layout (older pi):        <tmpdir>/pi-tmux-<safe>.sock
  local names = { 'pi-tmux-' .. safe .. '/bridge.sock', 'pi-tmux-' .. safe .. '.sock' }
  local seen, out = {}, {}
  local function add(dir)
    if not dir or dir == '' then return end
    dir = dir:gsub('/+$', '')
    for _, name in ipairs(names) do
      local p = dir .. '/' .. name
      if not seen[p] then
        seen[p] = true
        table.insert(out, p)
      end
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

--- Resolve a live pi-tmux socket for the current tmux session.
---@return string?, string?
local function socket_path()
  if not vim.env.TMUX then return nil, 'Not running in a tmux session' end
  local result = vim.system({ 'tmux', 'display-message', '-p', '#{session_id}' }, { text = true, timeout = TIMEOUT }):wait()
  if result.code ~= 0 or not result.stdout then return nil, 'Failed to read tmux session id' end
  local session_id = vim.trim(result.stdout)
  if session_id == '' then return nil, 'Empty tmux session id' end
  local paths = candidate_paths(session_id)
  for _, p in ipairs(paths) do
    if listener_alive(p) then return p, nil end
  end
  return nil, 'No pi listener for this tmux session. Is .pi/extensions/tmux-bridge.ts loaded?\nTried: ' .. table.concat(paths, ', ')
end

--- Send a JSON line ({"text": ...}) to the pi socket. Fully async.
---@param text string
local function send(text)
  local sock, err = socket_path()
  if not sock then
    notify(err or 'pi socket not found', vim.log.levels.ERROR)
    return
  end
  local payload = vim.json.encode { text = text } .. '\n'
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

  -- Validate the pi socket BEFORE prompting so the user doesn't type into a
  -- prompt that's about to fail.
  local sock, err = socket_path()
  if not sock then
    notify(err or 'pi socket not found', vim.log.levels.ERROR)
    return
  end

  local filepath = vim.fn.fnamemodify(bufname, ':.')
  local ft = vim.bo[buf].filetype or ''

  vim.ui.input({ prompt = 'pi: ' }, function(input)
    if not input or input == '' then return end
    local text = string.format('%s\n\n%s (L%d-L%d):\n```%s\n%s\n```', input, filepath, sline, eline, ft, selection)
    send(text)
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

  -- Pre-flight socket check (no input prompt here, but still nice to fail fast).
  local sock, err = socket_path()
  if not sock then
    notify(err or 'pi socket not found', vim.log.levels.ERROR)
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
  send(text)
end

return M
