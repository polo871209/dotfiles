return {
  {
    'catppuccin/nvim',
    priority = 1000,
    config = function()
      require('catppuccin').setup({
        transparent_background = true,
        custom_highlights = function(colors)
          return {
            -- Gruvbox Dark background for popup windows for consistancy
            NormalFloat = { bg = '#282828' },
            FloatBorder = { bg = '#282828', fg = '#fabd2f' },
          }
        end,
      })
    end,
    init = function()
      vim.cmd.colorscheme('catppuccin-mocha')

      -- Remove highlight from comments
      vim.cmd.hi('Comment gui=none')
    end,
  },
  -- Highlight todo, notes, etc in comments
  {
    'folke/todo-comments.nvim',
    event = 'VimEnter',
    dependencies = { 'nvim-lua/plenary.nvim' },
    opts = { signs = false },
  },
  -- Highlight text matching the current selection in visual mode
  {
    'wurli/visimatch.nvim',
    opts = {},
  },
  {
    'MeanderingProgrammer/render-markdown.nvim',
    ft = { 'markdown', 'codecompanion' },
  }
}
