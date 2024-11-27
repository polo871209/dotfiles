return {
  { -- You can easily change to a different colorscheme.
    -- Change the name of the colorscheme plugin below, and then
    -- change the command in the config to whatever the name of that colorscheme is.
    --
    -- If you want to see what colorschemes are already installed, you can use `:Telescope colorscheme`.
    'catppuccin/nvim',
    priority = 1000, -- Make sure to load this before all the other start plugins.
    config = function()
      -- Configure Catppuccin with transparent background
      require('catppuccin').setup {
        transparent_background = true,
      }
    end,
    init = function()
      -- Load the colorscheme here.
      -- Like many other themes, this one has different styles, and you could load
      -- any other, such as 'tokyonight-storm', 'tokyonight-moon', or 'tokyonight-day'.
      vim.cmd.colorscheme 'catppuccin-mocha'

      -- You can configure highlights by doing something like:
      vim.cmd.hi 'Comment gui=none'
    end,
  },
  -- {
  --   'rebelot/kanagawa.nvim',
  --   lazy = false, -- Load the plugin immediately
  --   priority = 1000, -- Ensures this plugin loads first for colors
  --   config = function()
  --     require('kanagawa').setup {
  --       compile = false, -- Enable compiling the colorscheme
  --       undercurl = true, -- Enable undercurls
  --       commentStyle = { italic = true },
  --       functionStyle = {},
  --       keywordStyle = { italic = true },
  --       statementStyle = { bold = true },
  --       typeStyle = {},
  --       transparent = false, -- Do not set background color
  --       dimInactive = false, -- Dim inactive window `:h hl-NormalNC`
  --       terminalColors = true, -- Define vim.g.terminal_color_{0,17}
  --       colors = { -- Add/modify theme and palette colors
  --         palette = {},
  --         theme = { wave = {}, lotus = {}, dragon = {}, all = {} },
  --       },
  --       overrides = function(colors) -- Add/modify highlights
  --         return {}
  --       end,
  --       theme = 'wave', -- Load "wave" theme when 'background' option is not set
  --       background = { -- Map the value of 'background' option to a theme
  --         dark = 'dragon', -- Try "dragon" !
  --         light = 'lotus',
  --       },
  --     }
  --     -- Activate the colorscheme
  --     vim.cmd 'colorscheme kanagawa'
  --   end,
  -- },
  -- Highlight todo, notes, etc in comments
  { 'folke/todo-comments.nvim', event = 'VimEnter', dependencies = { 'nvim-lua/plenary.nvim' }, opts = { signs = false } },
}
