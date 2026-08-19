-- Bootstrap only. Everything here must run before plugin/ is sourced
-- (:h startup step 8 vs 9); mapleader in particular must precede any keymap.
--
-- Layout follows :h lua-guide-config:
--   plugin/            scripts run automatically on startup
--   lua/               modules loaded on demand via require
--   after/ftplugin/    filetype-local settings
--   lsp/               server configs for vim.lsp.enable (:h lsp-config)

vim.loader.enable() -- Bytecode cache

vim.g.mapleader = ' '
vim.g.maplocalleader = ' '
