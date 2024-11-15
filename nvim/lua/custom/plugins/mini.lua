return { -- Collection of various small independent plugins/modules
  'echasnovski/mini.nvim',
  config = function()
    -- Better Around/Inside textobjects
    require('mini.ai').setup { n_lines = 500 }

    -- Add/delete/replace surroundings (brackets, quotes, etc.)
    require('mini.surround').setup()

    -- starting page
    require('mini.starter').setup {}

    -- ... and there is more!
    --  Check out: https://github.com/echasnovski/mini.nvim
  end,
}
