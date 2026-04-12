-- Clear search highlights
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Split screen
vim.keymap.set('n', '<leader>-', '<cmd>split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', '<cmd>vsplit<CR>', { desc = 'Vertical Split' })

-- Delete/change without yanking
vim.keymap.set('n', 'd', '"_d', { desc = 'Delete without yanking' })
vim.keymap.set('n', 'c', '"_c', { desc = 'Change without yanking' })

-- Paste without replacing clipboard
vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

-- Diffview toggle
local function toggle_diffview()
  local view = require('diffview.lib').get_current_view()
  if view then
    vim.cmd 'DiffviewClose'
  else
    vim.cmd 'DiffviewOpen'
  end
end

vim.keymap.set('n', '<leader>gd', toggle_diffview, { desc = '[G]it [D]iff Toggle' })
vim.keymap.set('n', '<leader>gc', ':DiffviewOpen ', { desc = '[G]it [C]ompare selection' })

-- Toggle diagnostics location list
vim.keymap.set('n', '<leader>tt', function()
  if vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 then
    vim.cmd 'lclose'
  else
    vim.diagnostic.setloclist()
    vim.cmd 'lopen'
  end
end, { desc = '[T]oggle [T]rouble' })

-- Auto-close location list on selection
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'qf',
  callback = function() vim.keymap.set('n', '<CR>', '<CR>:lclose<CR>', { buffer = true, silent = true }) end,
})

-- Keymaps for vim.pack
vim.keymap.set('n', '<leader>pu', function() vim.pack.update() end, { desc = '[P]ackage [U]pdate' })
vim.keymap.set('n', '<leader>ps', function() vim.pack.update(nil, { offline = true }) end, { desc = '[P]ackage [S]tatus' })
vim.keymap.set('n', '<leader>pl', function() vim.pack.update(nil, { target = 'lockfile' }) end, { desc = '[P]ackage [L]ockfile Sync' })

-- Run: resolve project root and command from .nvim-run, falls back to `just`
local function get_run_cmd()
  local root = vim.fs.root(0, { '.git', '.nvim-run', 'Justfile' }) or vim.fn.getcwd()
  local cmd = 'just'
  local run_file = root .. '/.nvim-run'
  local f = io.open(run_file, 'r')
  if f then
    cmd = vim.trim(f:read '*a')
    f:close()
  end
  return cmd, root
end

-- <leader>rf: Run in floating terminal
local last_run_term = nil
vim.keymap.set('n', '<leader>rf', function()
  vim.cmd 'w'
  if last_run_term and last_run_term:buf_valid() then
    last_run_term:close()
  end
  local cmd, root = get_run_cmd()
  local height = math.floor(vim.o.lines * 0.4)
  last_run_term = Snacks.terminal.open(cmd, {
    cwd = root,
    auto_close = false,
    win = {
      position = 'float',
      border = 'rounded',
      width = vim.o.columns,
      height = height,
      row = vim.o.lines - height - 2,
      col = 0,
      keys = { ['<C-c>'] = 'close' },
    },
  })
end, { desc = '[R]un [F]loat' })

-- <leader>rr: Run in next tmux window
vim.keymap.set('n', '<leader>rr', function()
  vim.cmd 'w'
  if vim.env.TMUX == nil then
    vim.notify('Not inside tmux', vim.log.levels.WARN)
    return
  end
  local cmd, root = get_run_cmd()
  local current = vim.trim(vim.fn.system 'tmux display-message -p "#{window_index}"')
  local target = tostring(tonumber(current) + 1)
  -- Ensure target window exists, or create it
  local windows = vim.trim(vim.fn.system 'tmux list-windows -F "#{window_index}"')
  local exists = false
  for w in windows:gmatch '%S+' do
    if w == target then
      exists = true
      break
    end
  end
  if not exists then
    vim.fn.system(string.format('tmux new-window -t %s -c %s', target, vim.fn.shellescape(root)))
    vim.fn.system(string.format("tmux send-keys -t %s %s Enter", target, vim.fn.shellescape(cmd)))
  else
    -- Interrupt whatever is running, clear the line, then run
    vim.fn.system(string.format('tmux send-keys -t %s C-c', target))
    vim.fn.system(string.format('tmux send-keys -t %s C-u', target))
    vim.fn.system(string.format("tmux send-keys -t %s %s Enter", target, vim.fn.shellescape('cd ' .. vim.fn.shellescape(root) .. ' && ' .. cmd)))
  end
  vim.fn.system(string.format('tmux select-window -t %s', target))
end, { desc = '[R]un tmux [R]un' })

-- OpenCode integration
vim.keymap.set('x', '<leader><leader>', function() require('opencode').send_selection() end, { desc = 'Send selection to OpenCode' })
vim.keymap.set('n', '<leader>da', function() require('opencode').send_diagnostics() end, { desc = '[D]iagnostic [A]sk' })
