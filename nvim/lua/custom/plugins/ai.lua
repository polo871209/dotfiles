return {
  {
    'zbirenbaum/copilot.lua',
    cmd = 'Copilot',
    event = 'InsertEnter',
    config = function()
      require('copilot').setup {
        suggestion = { enabled = false },
        panel = { enabled = false },
        copilot_model = 'claude-sonnet-4.5',
      }

      -- Toggle copilot with <leader>ai
      local copilot_enabled = true

      vim.keymap.set('n', '<leader>ai', function()
        vim.cmd 'Copilot toggle'
        copilot_enabled = not copilot_enabled

        local message = copilot_enabled and 'Copilot enabled' or 'Copilot disabled'
        Snacks.notifier.notify(message, 'warn', { title = 'Copilot' })
      end, { desc = 'Toggle Copilot' })
    end,
  },
  {
    'NickvanDyke/opencode.nvim',
    dependencies = {
      'folke/snacks.nvim',
    },
    config = function()
      ---@type opencode.Opts
      vim.g.opencode_opts = {
        provider = {
          enabled = 'tmux',
        },
      }

      -- Required for auto-reloading buffers when opencode edits files
      vim.o.autoread = true

      -- Smart 'oa' keymap: ask in normal mode, ask with selection in visual mode
      vim.keymap.set('n', 'oa', function() require('opencode').ask() end, { desc = 'OpenCode: Ask' })

      vim.keymap.set('x', 'oa', function() require('opencode').ask('@this: ', { submit = true }) end, { desc = 'OpenCode: Ask about selection' })
    end,
  },
}
