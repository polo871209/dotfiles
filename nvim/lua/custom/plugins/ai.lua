return { -- OpenCode AI Assistant Integration
  'NickvanDyke/opencode.nvim',
  event = 'VeryLazy',
  dependencies = {
    { 'folke/snacks.nvim', opts = { input = {}, picker = {}, terminal = {} } },
  },
  config = function()
    -- Configure OpenCode
    vim.g.opencode_opts = {
      -- Add custom configuration here if needed
    }

    -- Required for auto-reloading buffers when opencode edits files
    vim.o.autoread = true

    -- Smart 'oa' keymap: ask in normal mode, ask with selection in visual mode
    vim.keymap.set('n', 'oa', function()
      require('opencode').ask()
    end, { desc = 'OpenCode: Ask' })

    vim.keymap.set('x', 'oa', function()
      require('opencode').ask('@this: ', { submit = true })
    end, { desc = 'OpenCode: Ask about selection' })

    vim.keymap.set('n', 'oq', function()
      require('opencode').ask('@quickfix: ', { submit = true })
    end, { desc = 'OpenCode: Ask about quickfix' })

    vim.keymap.set('x', 'oq', function()
      require('opencode').ask('@quickfix @this: ', { submit = true })
    end, { desc = 'OpenCode: Ask about quickfix with selection' })
  end,
}
