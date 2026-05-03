local dap
local dapui
local loaded = false

local function load_dap()
  if loaded then return dap, dapui end
  loaded = true

  vim.pack.add {
    'https://github.com/nvim-neotest/nvim-nio',
    'https://github.com/rcarriga/nvim-dap-ui',
    'https://github.com/theHamsta/nvim-dap-virtual-text',
    'https://github.com/jay-babu/mason-nvim-dap.nvim',
    'https://github.com/leoluz/nvim-dap-go',
    'https://github.com/mfussenegger/nvim-dap-python',
    'https://github.com/mfussenegger/nvim-dap',
  }

  dap = require 'dap'
  dapui = require 'dapui'
  require('nvim-dap-virtual-text').setup {}

  ---@diagnostic disable-next-line: missing-fields
  dapui.setup {
    icons = { expanded = '▾', collapsed = '▸', current_frame = '*' },
    controls = {
      icons = {
        pause = '⏸',
        play = '▶',
        step_into = '⏎',
        step_over = '⏭',
        step_out = '⏮',
        step_back = 'b',
        run_last = '▶▶',
        terminate = '⏹',
        disconnect = '⏏',
      },
    },
    layouts = {
      {
        elements = {
          { id = 'scopes', size = 1 },
        },
        size = 40,
        position = 'left',
      },
      {
        elements = {
          { id = 'repl', size = 1 },
        },
        size = 10,
        position = 'bottom',
      },
    },
  }

  vim.api.nvim_set_hl(0, 'DapBreak', { fg = '#e51400' })
  vim.api.nvim_set_hl(0, 'DapStop', { fg = '#ffcc00' })
  local breakpoint_icons = { Breakpoint = '', BreakpointCondition = '', BreakpointRejected = '', LogPoint = '', Stopped = '' }
  for type, icon in pairs(breakpoint_icons) do
    local tp = 'Dap' .. type
    local hl = (type == 'Stopped') and 'DapStop' or 'DapBreak'
    vim.fn.sign_define(tp, { text = icon, texthl = hl, numhl = hl })
  end

  dap.listeners.after.event_initialized['dapui_config'] = dapui.open
  dap.listeners.before.event_terminated['dapui_config'] = dapui.close
  dap.listeners.before.event_exited['dapui_config'] = dapui.close

  require('dap-go').setup {
    delve = {
      detached = vim.fn.has 'win32' == 0,
    },
  }

  require('dap-python').setup 'uv'

  return dap, dapui
end

vim.keymap.set('n', '<leader>bc', function() load_dap().continue() end, { desc = 'Debug: Start/Continue' })
vim.keymap.set('n', '<leader>bi', function() load_dap().step_into() end, { desc = 'Debug: Step Into' })
vim.keymap.set('n', '<leader>bo', function() load_dap().step_over() end, { desc = 'Debug: Step Over' })
vim.keymap.set('n', '<leader>bO', function() load_dap().step_out() end, { desc = 'Debug: Step Out' })
vim.keymap.set('n', '<leader>bb', function() load_dap().toggle_breakpoint() end, { desc = 'Debug: Toggle Breakpoint' })
vim.keymap.set('n', '<leader>bu', function() select(2, load_dap()).toggle() end, { desc = 'Debug: Toggle UI' })
vim.keymap.set('n', '<leader>bt', function() load_dap().terminate() end, { desc = 'Debug: Terminate' })

vim.keymap.set('n', '<leader>?', function() select(2, load_dap()).eval(nil, { enter = true }) end)
