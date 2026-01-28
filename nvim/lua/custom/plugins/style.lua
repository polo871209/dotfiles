return {
  {
    'catppuccin/nvim',
    priority = 1000,
    config = function()
      require('catppuccin').setup {
        transparent_background = true,
        custom_highlights = function(colors)
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
}
