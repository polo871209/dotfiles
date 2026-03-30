vim.pack.add({ 'https://github.com/catppuccin/nvim' })

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

vim.cmd.colorscheme 'catppuccin-mocha'
vim.cmd.hi 'Comment gui=none' -- Remove italic from comments
