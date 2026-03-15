return {
  {
    'catppuccin/nvim',
    priority = 1000,
    config = function()
      require('catppuccin').setup {
        transparent_background = true,
        custom_highlights = function()
          return {
            -- Gruvbox-style popup backgrounds
            NormalFloat = { bg = '#282828' },
            FloatBorder = { bg = '#282828', fg = '#fabd2f' },
          }
        end,
      }
    end,
    init = function()
      vim.cmd.colorscheme 'catppuccin-mocha'
      vim.cmd.hi 'Comment gui=none' -- Remove italic from comments
    end,
  },
  {
    'folke/todo-comments.nvim',
    event = 'VimEnter',
    dependencies = { 'nvim-lua/plenary.nvim' },
    opts = { signs = false },
  },
  {
    'wurli/visimatch.nvim',
    opts = {},
  },
  {
    'MeanderingProgrammer/render-markdown.nvim',
    ft = { 'markdown', 'codecompanion' },
  },
  -- UI & Experience
  {
    'folke/which-key.nvim',
    event = 'VimEnter',
    opts = {
      delay = 200,
      spec = {
        { '<leader><leader>', group = 'OpenCode Ask' },
        { '<leader>b', group = 'De[B]ug' },
        { '<leader>g', group = '[G]it' },
        { '<leader>m', group = 'Split/Join' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>t', group = '[T]oggle' },
        { 'g', group = 'LSP Actions', mode = { 'n' } },
      },
    },
  },
  {
    'folke/noice.nvim',
    event = 'VeryLazy',
    dependencies = {
      'MunifTanjim/nui.nvim',
    },
    opts = {
      presets = {
        bottom_search = true,
      },
      cmdline = {
        enabled = true,
        view = 'cmdline_popup',
      },
      views = {
        cmdline_popup = {
          position = { row = 3, col = '50%' },
        },
      },
      -- Disable everything else to prevent behavior changes
      messages = { enabled = false },
      popupmenu = { enabled = false },
      notify = { enabled = false },
      lsp = {
        progress = { enabled = false },
        hover = { enabled = false },
        signature = { enabled = false },
        message = { enabled = false },
      },
    },
  },
  {
    'stevearc/quicker.nvim',
    ft = 'qf',
    opts = {},
  },
}
