return {
  --  Navigation & Motion
  {
    'christoomey/vim-tmux-navigator',
    cmd = {
      'TmuxNavigateLeft',
      'TmuxNavigateDown',
      'TmuxNavigateUp',
      'TmuxNavigateRight',
    },
    keys = {
      { '<c-h>', '<cmd><C-U>TmuxNavigateLeft<cr>' },
      { '<c-j>', '<cmd><C-U>TmuxNavigateDown<cr>' },
      { '<c-k>', '<cmd><C-U>TmuxNavigateUp<cr>' },
      { '<c-l>', '<cmd><C-U>TmuxNavigateRight<cr>' },
    },
  },
  {
    'folke/flash.nvim',
    event = 'VeryLazy',
    opts = {},
    -- stylua: ignore
    keys = {
      { "s", mode = { "n" }, function() require("flash").jump() end, desc = "Flash" },
      { "S", mode = { "n" }, function() require("flash").treesitter() end, desc = "Flash Treesitter" },
    },
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

  -- Coding & Editing Support
  { 'windwp/nvim-autopairs', event = 'InsertEnter', opts = {} },
  { 'NMAC427/guess-indent.nvim', opts = {} },
  { 'ekalinin/Dockerfile.vim' },

  -- Version Control (Git)
  {
    'lewis6991/gitsigns.nvim',
    event = { 'BufReadPre', 'BufNewFile' },
    opts = {
      signs = {
        add = { text = '+' },
        change = { text = '~' },
        delete = { text = '_' },
        topdelete = { text = '‾' },
        changedelete = { text = '~' },
      },
    },
  },
  {
    'sindrets/diffview.nvim',
    cmd = { 'DiffviewOpen', 'DiffviewClose', 'DiffviewToggleFiles', 'DiffviewFocusFiles' },
  },
}
