local M = {}

local TIMEOUT = 500
local API_TIMEOUT = 2000
local CACHE_TTL_MS = 30000

---@type { port: string, session_id: string, window: string?, timestamp: number }?
local cache = nil

--- Shell out and return the result.
---@param cmd string[]
---@param timeout? number
---@return vim.SystemCompleted
local function run(cmd, timeout) return vim.system(cmd, { text = true, timeout = timeout or TIMEOUT }):wait() end

---@param msg string
---@param level? integer
local function notify(msg, level)
  vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

--- Find the listening port for a given opencode PID (checks the process and its children).
---@param pid number
---@return string?
local function find_port_for_pid(pid)
  local pids_to_check = { pid }
  local children = run { 'pgrep', '-P', tostring(pid) }
  if children.code == 0 then
    for child_pid in children.stdout:gmatch '%d+' do
      table.insert(pids_to_check, tonumber(child_pid))
    end
  end

  for _, p in ipairs(pids_to_check) do
    local lsof = run { 'lsof', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', tostring(p) }
    if lsof.code == 0 then
      local port = lsof.stdout:match ':(%d+)'
      if port then return port end
    end
  end
  return nil
end

--- Find the tmux window index for a given PID by checking all panes.
---@param pid number
---@return string?
local function find_tmux_window(pid)
  local result = run { 'tmux', 'list-panes', '-s', '-F', '#{window_index}:#{window_name}:#{pane_pid}' }
  if result.code ~= 0 then return nil end
  local pid_str = tostring(pid)
  for line in result.stdout:gmatch '[^\n]+' do
    local win_idx, win_name, pane_pid = line:match '^(%d+):(.+):(%d+)$'
    if pane_pid == pid_str then return win_idx .. ':' .. win_name end
    if pane_pid then
      local children = run { 'pgrep', '-P', pane_pid }
      if children.code == 0 then
        for child in children.stdout:gmatch '%d+' do
          if child == pid_str then return win_idx .. ':' .. win_name end
        end
      end
    end
  end
  return nil
end

--- Discover all opencode instances running in the current tmux session.
---@return { pid: number, port: string, window: string }[], string?
local function discover_instances()
  if not vim.env.TMUX then return {}, 'Not running in a tmux session' end

  local result = run { 'pgrep', '-f', 'opencode.*--port' }
  if result.code ~= 0 or not result.stdout or result.stdout == '' then return {}, 'OpenCode is not running (start it with `oc`)' end

  local pids = {}
  for pid_str in result.stdout:gmatch '%d+' do
    table.insert(pids, tonumber(pid_str))
  end

  local tmux_env = vim.pesc(vim.env.TMUX)
  local instances = {}

  for _, pid in ipairs(pids) do
    local env = run { 'ps', 'eww', '-p', tostring(pid) }
    if env.code == 0 and env.stdout:match('TMUX=' .. tmux_env) then
      local port = find_port_for_pid(pid)
      if port then
        local window = find_tmux_window(pid) or '?'
        table.insert(instances, { pid = pid, port = port, window = window })
      end
    end
  end

  if #instances == 0 then return {}, 'No OpenCode instance with a listening port found in this tmux session' end

  return instances, nil
end

--- Resolve the port to use. Only prompts when there are multiple instances.
---@param callback fun(port: string?, single_instance: boolean, window: string?)
local function resolve_port(callback)
  if cache and (vim.uv.now() - cache.timestamp) < CACHE_TTL_MS then
    callback(cache.port, true, cache.window)
    return
  end

  local instances, err = discover_instances()
  if #instances == 0 then
    notify(err or 'No OpenCode instance found', vim.log.levels.ERROR)
    callback(nil, false, nil)
    return
  end

  if #instances == 1 then
    callback(instances[1].port, true, instances[1].window)
    return
  end

  vim.schedule(function()
    vim.ui.select(instances, {
      prompt = 'Pick OpenCode instance:',
      format_item = function(item) return string.format('window %s', item.window) end,
    }, function(choice)
      if not choice then
        callback(nil, false, nil)
        return
      end
      callback(choice.port, false, choice.window)
    end)
  end)
end

--- Fetch sessions. Auto-picks the top session when `auto` is true, otherwise prompts. Caches the choice.
---@param port string
---@param auto boolean
---@param window string?
---@param callback fun(session_id: string?)
local function resolve_session(port, auto, window, callback)
  if cache and cache.port == port and (vim.uv.now() - cache.timestamp) < CACHE_TTL_MS then
    callback(cache.session_id)
    return
  end

  vim.system({
    'curl', '-sf', 'http://localhost:' .. port .. '/session?limit=10',
  }, { text = true, timeout = API_TIMEOUT }, function(result)
    if result.code ~= 0 or not result.stdout or result.stdout == '' then
      notify('Failed to fetch sessions: ' .. (result.stderr or 'unknown error'), vim.log.levels.ERROR)
      callback(nil)
      return
    end

    local ok, sessions = pcall(vim.json.decode, result.stdout)
    if not ok or not sessions or #sessions == 0 then
      notify('No OpenCode sessions found', vim.log.levels.ERROR)
      callback(nil)
      return
    end

    if auto or #sessions == 1 then
      cache = { port = port, session_id = sessions[1].id, window = window, timestamp = vim.uv.now() }
      callback(sessions[1].id)
      return
    end

    vim.schedule(function()
      vim.ui.select(sessions, {
        prompt = 'Pick session:',
        format_item = function(s) return s.title or s.slug or s.id end,
      }, function(choice)
        if not choice then
          callback(nil)
          return
        end
        cache = { port = port, session_id = choice.id, window = window, timestamp = vim.uv.now() }
        callback(choice.id)
      end)
    end)
  end)
end

--- Resolve port + session, then call back with both.
---@param callback fun(port: string, session_id: string, window: string?)
local function resolve(callback)
  resolve_port(function(port, single_instance, window)
    if not port then return end
    resolve_session(port, single_instance, window, function(session_id)
      if not session_id then return end
      callback(port, session_id, window)
    end)
  end)
end

--- Post parts to a resolved port + session. Fully async.
---@param parts table[]
---@param port string
---@param session_id string
local function post_to_opencode(parts, port, session_id)
  vim.system({
    'curl', '-sf', '-X', 'POST',
    '-H', 'Content-Type: application/json',
    'http://localhost:' .. port .. '/session/' .. session_id .. '/prompt_async',
    '-d', vim.json.encode { parts = parts },
  }, { text = true, timeout = API_TIMEOUT }, function(result)
    if result.code ~= 0 then
      notify('Failed to send: ' .. (result.stderr or 'unknown error'), vim.log.levels.ERROR)
    else
      notify('Sent to OpenCode')
    end
  end)
end

function M.send_selection()
  -- Step 1: resolve port + session (may show pickers)
  resolve(function(port, session_id, window)
    -- Step 2: gather buffer info (on main thread)
    vim.schedule(function()
      vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<esc>', true, false, true), 'x', true)

      local buf = vim.api.nvim_get_current_buf()
      local bufname = vim.api.nvim_buf_get_name(buf)
      if bufname == '' then
        notify('Buffer has no file', vim.log.levels.WARN)
        return
      end

      local start_pos = vim.api.nvim_buf_get_mark(buf, '<')
      local end_pos = vim.api.nvim_buf_get_mark(buf, '>')
      if start_pos[1] == 0 and end_pos[1] == 0 then
        notify('No visual selection', vim.log.levels.WARN)
        return
      end

      local absolute_path = vim.fn.fnamemodify(bufname, ':p')
      local filepath = vim.fn.fnamemodify(bufname, ':.')

      -- Step 3: prompt for message (last UI interaction before send)
      local prompt = 'OpenCode'
      if window then
        local win_idx = window:match '^(%d+)'
        local win_name = window:match '^%d+:(.+)$'
        local label = (win_name and win_name:lower():find 'opencode') and win_idx or window
        prompt = 'OpenCode [' .. label .. ']'
      end
      vim.ui.input({ prompt = prompt }, function(input)
        if not input or input == '' then return end
        post_to_opencode({
          { type = 'file', mime = 'text/plain', url = 'file://' .. absolute_path, filename = filepath },
          { type = 'text', text = string.format('%s (%s:L%d-L%d)', input, filepath, start_pos[1], end_pos[1]) },
        }, port, session_id)
      end)
    end)
  end)
end

function M.send_diagnostics()
  resolve(function(port, session_id)
    vim.schedule(function()
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
        table.insert(lines, string.format('[%s] Line %d: %s', severity, d.lnum + 1, d.message:gsub('\n', ' ')))
      end

      local absolute_path = vim.fn.fnamemodify(bufname, ':p')
      local filepath = vim.fn.fnamemodify(bufname, ':.')

      post_to_opencode({
        { type = 'file', mime = 'text/plain', url = 'file://' .. absolute_path, filename = filepath },
        { type = 'text', text = 'Please review these diagnostics and help me fix them\n\n' .. filepath .. ':\n' .. table.concat(lines, '\n') },
      }, port, session_id)
    end)
  end)
end

--- Invalidate the cache (switch session or after restarting opencode).
function M.clear_cache()
  cache = nil
  notify('OpenCode cache cleared')
end

return M
