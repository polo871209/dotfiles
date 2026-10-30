if vim.g.pi_agent then return end

vim.pack.add { 'https://github.com/echasnovski/mini.nvim' }

require('mini.ai').setup { n_lines = 500 }

require('mini.surround').setup()

-- Icons for the picker (lua/picker/display.lua reads MiniIcons directly) and
-- for neo-tree, which asks for 'nvim-web-devicons' by name; the mock answers
-- under that name so the extra plugin is not needed.
local icons = require 'mini.icons'
icons.setup()
icons.mock_nvim_web_devicons()

require('mini.pairs').setup()

require('mini.diff').setup {
    view = { style = 'sign', signs = { add = '+', change = '~', delete = '_' } },
}
