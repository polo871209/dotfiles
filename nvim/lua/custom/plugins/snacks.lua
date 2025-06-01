return {
  'folke/snacks.nvim',
  priority = 1000,
  lazy = false,
  ---@type snacks.Config
  opts = {
    -- your configuration comes here
    -- or leave it empty to use the default settings
    -- refer to the configuration section below
    bigfile = { enabled = true },
    indent = { enabled = true },
    lazygit = { configure = false },
    notifier = {
      enabled = true,
      level = vim.log.levels.WARN,
    },
    toggle = { enabled = true },
    words = { enabled = true },
  },
  keys = {
    {
      '<leader>lg',
      function()
        Snacks.lazygit()
      end,
      desc = '[L]azy[g]it',
    },
    {
      '<leader>gb',
      function()
        Snacks.git.blame_line()
      end,
      desc = '[G]it [B]lame Line',
    },
    {
      '<leader>gB',
      function()
        Snacks.gitbrowse()
      end,
      desc = '[G]it [B]rowse',
    },
    {
      '<leader>tn',
      function()
        Snacks.notifier.hide()
      end,
      desc = 'Dismiss All [N]otifications',
    },
  },
  init = function()
    vim.api.nvim_create_autocmd('User', {
      pattern = 'VeryLazy',
      callback = function()
        -- Setup some globals for debugging (lazy-loaded)
        _G.dd = function(...)
          Snacks.debug.inspect(...)
        end
        _G.bt = function()
          Snacks.debug.backtrace()
        end
        vim.print = _G.dd -- Override print to use snacks for `:=` command

        -- Create some toggle mappings
        Snacks.toggle.option('wrap', { name = 'Wrap' }):map '<leader>tw'
        Snacks.toggle.diagnostics():map '<leader>td'
      end,
    })
  end,
  config = function(_, opts)
    -- Require the Snacks module
    local Snacks = require 'snacks'

    -- Initialize the plugin with the provided options
    Snacks.setup(opts)

    -- Optionally, you can set up global variables or additional configurations here
  end,
}
