-- Bootstrap only. Everything here must run before plugin/ is sourced
-- (:h startup step 8 vs 9); mapleader in particular must precede any keymap.
vim.loader.enable()

vim.g.mapleader = ' '
vim.g.maplocalleader = ' '
