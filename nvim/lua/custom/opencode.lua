-- Send visual selection to OpenCode in the same tmux session

local M = {}

local function get_visual_selection()
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<esc>', true, false, true), 'x', true)

  local buf = vim.api.nvim_get_current_buf()
  local start_pos = vim.api.nvim_buf_get_mark(buf, '<')
  local end_pos = vim.api.nvim_buf_get_mark(buf, '>')
  local lines = vim.api.nvim_buf_get_lines(buf, start_pos[1] - 1, end_pos[1], false)
  local filepath = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':.')

  return {
    text = table.concat(lines, '\n'),
    filepath = filepath,
    start_line = start_pos[1],
    end_line = end_pos[1],
  }
end

local function get_opencode_port()
  -- Get current tmux session info from $TMUX
  local current_tmux = vim.env.TMUX
  if not current_tmux then return nil, 'Not running in tmux session' end

  -- Find opencode server port
  local result = vim.system({ 'pgrep', '-f', 'opencode.*--port' }, { text = true, timeout = 500 }):wait()
  if result.code ~= 0 then return nil, 'OpenCode not running' end

  -- Get all PIDs
  local pids = {}
  for pid_str in result.stdout:gmatch '%d+' do
    table.insert(pids, tonumber(pid_str))
  end

  if #pids == 0 then return nil, 'No OpenCode processes found' end

  -- Find PID in same tmux session by checking $TMUX env var of each process
  local target_pid = nil
  for _, pid in ipairs(pids) do
    -- Get environment variables from process (macOS compatible)
    local env_result = vim.system({ 'ps', 'eww', '-p', tostring(pid) }, { text = true, timeout = 500 }):wait()
    if env_result.code == 0 and env_result.stdout ~= '' then
      -- Extract TMUX value from environment (format: TMUX=/path/to/socket,session,window)
      local tmux_value = env_result.stdout:match 'TMUX=([^%s]+)'
      if tmux_value == current_tmux then
        target_pid = pid
        break
      end
    end
  end

  if not target_pid then return nil, 'OpenCode not found in current tmux session' end

  -- Get port from lsof
  local lsof = vim.system({ 'lsof', '-w', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', tostring(target_pid) }, { text = true, timeout = 500 }):wait()
  if lsof.code ~= 0 then return nil, 'Failed to get port for PID ' .. target_pid end

  local port = lsof.stdout:match ':(%d+)'
  if not port then return nil, 'Could not find OpenCode port for PID ' .. target_pid end

  return port, nil
end

local function send_to_opencode(message, port)
  -- https://opencode.ai/docs/server/#tui
  vim.system({
    'curl',
    '-s',
    '-X',
    'POST',
    '-H',
    'Content-Type: application/json',
    'http://localhost:' .. port .. '/tui/append-prompt',
    '-d',
    vim.fn.json_encode { text = message },
  }, { text = true, timeout = 500 }, function(append_result)
    if append_result.code ~= 0 then
      vim.schedule(function() vim.notify('Failed to append: ' .. (append_result.stderr or 'unknown error'), vim.log.levels.ERROR) end)
      return
    end

    vim.system({
      'curl',
      '-s',
      '-X',
      'POST',
      'http://localhost:' .. port .. '/tui/submit-prompt',
    }, { text = true, timeout = 500 }, function(submit_result)
      vim.schedule(function()
        if submit_result.code ~= 0 then
          vim.notify('Failed to submit: ' .. (submit_result.stderr or 'unknown error'), vim.log.levels.ERROR)
        else
          vim.notify('Message sent to OpenCode', vim.log.levels.INFO)
        end
      end)
    end)
  end)
end

function M.send_selection()
  -- Get port upfront before showing input
  local port, err = get_opencode_port()
  if not port then
    vim.notify(err, vim.log.levels.ERROR)
    return
  end

  local selection = get_visual_selection()

  -- Show input popup only after port is ready
  vim.ui.input({
    prompt = 'OpenCode',
    default = '',
  }, function(input)
    if not input or input == '' then return end

    -- Format message: question + code block + file mention
    local message = string.format('%s\n\n```\n%s\n```\n@%s:L%d-L%d ', input, selection.text, selection.filepath, selection.start_line, selection.end_line)

    send_to_opencode(message, port)
  end)
end

function M.send_diagnostics()
  -- Get port upfront
  local port, err = get_opencode_port()
  if not port then
    vim.notify(err, vim.log.levels.ERROR)
    return
  end

  local buf = vim.api.nvim_get_current_buf()
  local filepath = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':.')
  local diagnostics = vim.diagnostic.get(buf)

  if #diagnostics == 0 then
    vim.notify('No diagnostics in current buffer', vim.log.levels.WARN)
    return
  end

  -- Group diagnostics by severity
  local severity_names = {
    [vim.diagnostic.severity.ERROR] = 'ERROR',
    [vim.diagnostic.severity.WARN] = 'WARNING',
    [vim.diagnostic.severity.INFO] = 'INFO',
    [vim.diagnostic.severity.HINT] = 'HINT',
  }

  -- Build diagnostic message
  local diagnostic_lines = {}
  table.insert(diagnostic_lines, string.format('@%s\n', filepath))

  for _, diagnostic in ipairs(diagnostics) do
    local severity = severity_names[diagnostic.severity] or 'UNKNOWN'
    local line = diagnostic.lnum + 1 -- lnum is 0-indexed
    local message = diagnostic.message:gsub('\n', ' ') -- Flatten multi-line messages
    table.insert(diagnostic_lines, string.format('[%s] Line %d: %s', severity, line, message))
  end

  local diagnostics_text = table.concat(diagnostic_lines, '\n')

  -- Format message: default prompt + diagnostics
  local message = string.format('Please review these diagnostics and help me fix them\n\n%s', diagnostics_text)

  send_to_opencode(message, port)
end

return M
