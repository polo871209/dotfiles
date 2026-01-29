return {
  'folke/snacks.nvim',
  priority = 1000,
  lazy = false,
  opts = {
    bigfile = { enabled = true },
    indent = { enabled = true },
    input = { enabled = true },
    lazygit = {
      configure = false,
      win = {
        style = 'lazygit',
      },
    },
    styles = {
      lazygit = {
        width = 0.99,
        height = 0.99,
      },
    },
    notifier = {
      enabled = true,
      level = vim.log.levels.WARN,
    },
    terminal = { enabled = true },
    toggle = { enabled = true },
    words = { enabled = true },
  },
  keys = {
    {
      '<leader>lg',
      function() Snacks.lazygit() end,
      desc = '[L]azy[g]it',
    },
    {
      '<leader>gb',
      function() Snacks.git.blame_line() end,
      desc = '[G]it [B]lame Line',
    },
    {
      '<leader>gB',
      function() Snacks.gitbrowse() end,
      desc = '[G]it [B]rowse',
    },
    {
      '<leader>tn',
      function() Snacks.notifier.hide() end,
      desc = 'Dismiss All [N]otifications',
    },
  },
  init = function()
    vim.api.nvim_create_autocmd('User', {
      pattern = 'VeryLazy',
      callback = function()
        -- Toggle mappings
        Snacks.toggle.option('wrap', { name = 'Wrap' }):map '<leader>tw'
        Snacks.toggle.diagnostics():map '<leader>td'
      end,
    })
  end,
}
