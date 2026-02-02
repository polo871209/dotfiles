return {
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
  { 'ekalinin/Dockerfile.vim' },
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
  { 'NMAC427/guess-indent.nvim', opts = {} },
  { 'numToStr/Comment.nvim', opts = {} },
  {
    'sindrets/diffview.nvim',
    cmd = { 'DiffviewOpen', 'DiffviewClose', 'DiffviewToggleFiles', 'DiffviewFocusFiles' },
  },
  {
    'stevearc/quicker.nvim',
    ft = 'qf',
    opts = {},
  },
  {
    'windwp/nvim-autopairs',
    event = 'InsertEnter',
    opts = {},
  },
}
