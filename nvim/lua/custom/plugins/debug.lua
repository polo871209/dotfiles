return {
  {
    'mfussenegger/nvim-dap',
    dependencies = {
      -- Debug UI
      'rcarriga/nvim-dap-ui',
      'nvim-neotest/nvim-nio',
      'theHamsta/nvim-dap-virtual-text',

      -- Install debug adapters
      'mason-org/mason.nvim',
      'jay-babu/mason-nvim-dap.nvim',

      -- Language-specific debuggers
      'leoluz/nvim-dap-go',
      'mfussenegger/nvim-dap-python',
    },
    config = function()
      local dap = require 'dap'
      local dapui = require 'dapui'
      require('nvim-dap-virtual-text').setup()

      require('mason-nvim-dap').setup {
        automatic_installation = true,
        handlers = {},
        ensure_installed = {
          'delve',
        },
      }

      -- DAP UI setup
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
              -- { id = 'console', size = 1 },
            },
            size = 10,
            position = 'bottom',
          },
        },
      }

      -- Change breakpoint icons
      vim.api.nvim_set_hl(0, 'DapBreak', { fg = '#e51400' })
      vim.api.nvim_set_hl(0, 'DapStop', { fg = '#ffcc00' })
      local breakpoint_icons = { Breakpoint = '', BreakpointCondition = '', BreakpointRejected = '', LogPoint = '', Stopped = '' }
      for type, icon in pairs(breakpoint_icons) do
        local tp = 'Dap' .. type
        local hl = (type == 'Stopped') and 'DapStop' or 'DapBreak'
        vim.fn.sign_define(tp, { text = icon, texthl = hl, numhl = hl })
      end

      vim.keymap.set('n', '<leader>bc', dap.continue, { desc = 'Debug: Start/Continue' })
      vim.keymap.set('n', '<leader>bi', dap.step_into, { desc = 'Debug: Step Into' })
      vim.keymap.set('n', '<leader>bo', dap.step_over, { desc = 'Debug: Step Over' })
      vim.keymap.set('n', '<leader>bO', dap.step_out, { desc = 'Debug: Step Out' })
      vim.keymap.set('n', '<leader>bb', dap.toggle_breakpoint, { desc = 'Debug: Toggle Breakpoint' })
      vim.keymap.set('n', '<leader>bu', dapui.toggle, { desc = 'Debug: Toggle UI' })
      vim.keymap.set('n', '<leader>bt', dap.terminate, { desc = 'Debug: Terminate' })

      vim.keymap.set('n', '<leader>?', function() require('dapui').eval(nil, { enter = true }) end)

      dap.listeners.after.event_initialized['dapui_config'] = dapui.open
      dap.listeners.before.event_terminated['dapui_config'] = dapui.close
      dap.listeners.before.event_exited['dapui_config'] = dapui.close

      -- Go debug config
      require('dap-go').setup {
        delve = {
          detached = vim.fn.has 'win32' == 0,
        },
      }

      require('dap-python').setup 'uv'
    end,
  },
}
