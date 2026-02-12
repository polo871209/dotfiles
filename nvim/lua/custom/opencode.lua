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
  if not vim.env.TMUX then return nil, 'Not running in tmux session' end

  local result = vim.system({ 'pgrep', '-f', 'opencode.*--port' }, { text = true, timeout = 500 }):wait()
  if result.code ~= 0 then return nil, 'OpenCode not running' end

  local pids = {}
  for pid_str in result.stdout:gmatch '%d+' do
    table.insert(pids, tonumber(pid_str))
  end
  if #pids == 0 then return nil, 'No OpenCode processes found' end

  local target_pid = nil
  for _, pid in ipairs(pids) do
    local env = vim.system({ 'ps', 'eww', '-p', tostring(pid) }, { text = true, timeout = 500 }):wait()
    if env.code == 0 and env.stdout:match('TMUX=' .. vim.pesc(vim.env.TMUX)) then
      target_pid = pid
      break
    end
  end
  if not target_pid then return nil, 'OpenCode not found in current tmux session' end

  local pids_to_check = { target_pid }
  local children = vim.system({ 'pgrep', '-P', tostring(target_pid) }, { text = true, timeout = 500 }):wait()
  if children.code == 0 then
    for child_pid in children.stdout:gmatch '%d+' do
      table.insert(pids_to_check, tonumber(child_pid))
    end
  end

  for _, pid in ipairs(pids_to_check) do
    local lsof = vim.system({ 'lsof', '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', tostring(pid) }, { text = true, timeout = 500 }):wait()
    if lsof.code == 0 then
      local port = lsof.stdout:match ':(%d+)'
      if port then return port, nil end
    end
  end

  return nil, 'OpenCode found but no listening port detected'
end

local function send_to_opencode(message, port)
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
  local port, err = get_opencode_port()
  if not port then
    vim.notify(err, vim.log.levels.ERROR)
    return
  end

  local selection = get_visual_selection()

  vim.ui.input({ prompt = 'OpenCode', default = '' }, function(input)
    if not input or input == '' then return end
    local message = string.format('%s\n\n```\n%s\n```\n%s:L%d-L%d ', input, selection.text, selection.filepath, selection.start_line, selection.end_line)
    send_to_opencode(message, port)
  end)
end

function M.send_diagnostics()
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

  local severity_names = {
    [vim.diagnostic.severity.ERROR] = 'ERROR',
    [vim.diagnostic.severity.WARN] = 'WARNING',
    [vim.diagnostic.severity.INFO] = 'INFO',
    [vim.diagnostic.severity.HINT] = 'HINT',
  }

  local diagnostic_lines = { string.format('@%s\n', filepath) }
  for _, diagnostic in ipairs(diagnostics) do
    local severity = severity_names[diagnostic.severity] or 'UNKNOWN'
    local line = diagnostic.lnum + 1
    local message = diagnostic.message:gsub('\n', ' ')
    table.insert(diagnostic_lines, string.format('[%s] Line %d: %s', severity, line, message))
  end

  local message = string.format('Please review these diagnostics and help me fix them\n\n%s', table.concat(diagnostic_lines, '\n'))
  send_to_opencode(message, port)
end

return M
