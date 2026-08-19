-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

-- https://emojicombos.com/one-piece
local header_art = [[⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
                    ⣀⣀⣀⣀⣀⣀⣀⣀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡴⠖⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠙⠲⢤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⣀⠀⠙⢦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⣰⠋⠀⡆⢀⠀⠀⠀⢤⢾⣱⣜⣾⣧⣶⣶⣶⣿⣷⣷⣶⣦⣤⣄⡀⣼⣞⣆⠈⢧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⣼⠃⠀⠀⡿⡏⡇⡄⢀⣼⣷⣿⣿⣿⣿⣿⣿⡿⠿⣿⡿⠿⠿⠿⠿⢿⣿⣿⣿⣢⡀⢧⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⣰⡇⠀⠀⣤⠻⡽⣼⣿⣿⣿⣿⡿⠿⠛⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠛⠷⢦⣀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⣿⠀⠀⠀⣌⢷⣿⣿⡿⠟⢋⡡⠀⠀⢀⣠⣤⣴⣶⣿⣿⣿⣿⣿⣷⣶⣤⣄⡀⠀⠀⠀⠀⠀⠀⣈⡙⠶⣤⡀⠀⠀⠀
  ⠀⠀⠀⠀⠀⣿⠀⠀⢦⣸⠛⠛⢁⡀⣀⣈⢀⣴⣾⣿⣿⣿⠏⣿⢿⣿⣿⣿⡏⠈⢻⣿⠿⣿⣶⣔⢿⣦⣠⣮⣽⠛⠀⠀⠙⢦⠀⠀
  ⠀⠀⠀⠀⠀⢿⠀⣠⠞⢩⣴⣿⡿⡿⣯⣷⣿⣿⣿⣿⣿⠏⢠⡿⢸⣿⣿⡟⠀⠀⠀⢻⡆⠘⣿⣿⣷⣝⠺⣿⣦⠀⠀⠀⠀⠀⢳⡀
  ⠀⠀⠀⠀⠀⣨⠟⠁⠐⢷⡹⠋⣰⣿⣿⣿⣿⣿⣿⣿⠏⠀⢸⠃⢸⣿⡟⠀⠀⠀⠀⠸⡇⠀⠘⣿⣿⣿⣷⣄⡁⠀⠀⠀⠀⠀⠈⡇
  ⠀⠀⠀⣠⠞⠁⠀⠀⠀⠈⢀⣼⣿⣿⣿⣿⠏⢸⣿⠇⠀⠠⠏⠀⢸⠏⠀⠀⠀⠀⠀⠀⠇⠀⠀⢸⣿⣿⣏⠉⡉⡀⠀⠀⠀⠀⣰⡇
  ⠀⠀⡼⠁⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣿⡟⠀⢸⡟⠀⠀⠀⠀⠘⡏⣀⣿⡒⡿⠀⠀⠀⣀⠀⠀⠈⣿⣿⣿⣧⣿⣿⡆⠀⠀⣠⠏⠀
  ⠀⣼⠃⠀⢀⣶⣖⡄⠀⣾⣿⣿⣿⣿⣿⠃⠀⢸⣛⣲⣦⣤⣤⣤⣴⡟⠙⣷⣤⣤⠴⠾⠥⣤⡀⠀⣿⣿⡿⠿⣿⣿⠃⢀⡴⠁⠀⠀
  ⢸⡇⠀⠀⣼⣸⣻⢀⢰⣿⣿⣿⣿⣿⣿⠀⠸⢿⣶⣶⣦⠶⠋⡼⠟⠀⠀⡏⠉⣟⠻⣿⠿⣋⠁⠀⣿⣿⣮⣨⡾⣣⡼⠋⠀⠀⠀⠀
  ⢸⡇⠀⠀⣿⣿⢸⡻⣸⣿⡟⣭⢿⣿⡽⠄⠀⠀⠀⠀⠀⠀⠀⣠⣶⡀⠀⢻⣲⡦⣉⡋⠙⠏⠀⢸⠋⣞⣹⠗⠋⠁⠀⠀⠀⠀⠀⠀
  ⠘⣇⠀⠀⢿⣾⣯⣝⠮⢹⣇⠇⣷⡹⣧⠀⠀⠀⠀⢀⡠⠚⠀⠀⠈⠁⠀⠘⠉⠀⠀⠙⢦⠀⠀⢸⣾⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠘⣆⠈⡪⠽⣿⣽⠶⠚⠻⣮⣙⠳⢿⡄⠀⠀⠀⠋⠀⠀⢀⣠⠤⠤⠤⠤⢄⣀⠀⠀⠈⠇⠀⣾⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠘⢶⣍⢻⠒⢺⠾⠩⠽⡇⣈⣙⣶⣷⡀⠀⠀⢀⡤⠚⠉⢀⣤⢴⢶⣤⣄⠉⠙⠲⢤⡀⢠⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠈⠉⠋⠉⠉⠉⠉⠉⠀⠀⠀⠈⠻⣦⣀⡉⢀⡠⠞⠉⢠⠏⠘⡄⠻⡍⠲⢦⣤⠷⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⡶⣤⣤⣄⣀⣤⣥⣤⣶⠞⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡏⠛⠿⢿⣿⣿⡿⣿⡃⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣴⠇⠀⠀⠀⠉⢻⣿⣿⣣⢿⣶⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣤⣴⣶⣿⣿⣯⠀⠀⠀⠀⠀⠀⠘⠛⠋⠈⠋⠙⣿⣷⣦⣤⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
]]

vim.pack.add { 'https://github.com/echasnovski/mini.nvim' }

require('mini.ai').setup { n_lines = 500 }

require('mini.surround').setup()

-- Icons for the picker (lua/picker/display.lua reads MiniIcons directly) and
-- for neo-tree, which asks for 'nvim-web-devicons' by name; the mock answers
-- under that name so the extra plugin is not needed.
local icons = require 'mini.icons'
icons.setup()
icons.mock_nvim_web_devicons()

-- Unlike nvim-autopairs, mini.pairs leaves <CR> alone: pressing Enter between
-- a pair relies on the filetype's indentexpr instead of always opening an
-- indented blank line.
require('mini.pairs').setup()

local starter = require 'mini.starter'
starter.setup {
    items = { starter.sections.recent_files(3, true) },
    header = header_art,
    footer = '',
}
