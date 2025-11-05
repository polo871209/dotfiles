-- Set <space> as the leader key
-- See `:help mapleader`
--  NOTE: Must happen before plugins are loaded (otherwise wrong leader will be used)
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- [[ Setting options ]]
-- See `:help vim.o`
-- NOTE: You can change these options as you wish!
--  For more options, you can see `:help option-list`

vim.o.number = true
vim.o.relativenumber = true

-- Enable mouse mode, can be useful for re sizing splits for example!
vim.o.mouse = 'a'

-- Don't show the mode, since it's already in the status line
vim.o.showmode = false

-- Sync clipboard between OS and Neovim.
-- See `:help 'clipboard'`
vim.schedule(function()
  vim.o.clipboard = 'unnamedplus'
end)

-- Enable break indent
vim.o.breakindent = true

-- Save undo history
vim.o.undofile = true

-- Case-insensitive searching UNLESS \C or one or more capital letters in the search term
vim.o.ignorecase = true
vim.o.smartcase = true

-- Keep signcolumn on by default
vim.o.signcolumn = 'yes'

-- Decrease update time
vim.o.updatetime = 250

-- Decrease mapped sequence wait time
-- Displays which-key popup sooner
vim.o.timeoutlen = 300

-- Configure how new splits should be opened
vim.o.splitright = true
vim.o.splitbelow = true

-- Sets how neovim will display certain whitespace characters in the editor.
--  See `:help 'list'`
--  and `:help 'listchars'`
--  Notice listchars is set using `vim.opt` instead of `vim.o`.
--  It is very similar to `vim.o` but offers an interface for conveniently interacting with tables.
--   See `:help lua-options`
--   and `:help lua-options-guide`
vim.o.list = true
vim.opt.listchars = { trail = '·', nbsp = '␣', tab = '» ' }

-- Preview substitutions live, as you type!
vim.o.inccommand = 'split'

-- Show which line your cursor is on
vim.o.cursorline = true

-- Minimal number of screen lines to keep above and below the cursor.
vim.o.scrolloff = 10

-- Disable line wrap
vim.o.wrap = false

-- Disable status line at the bottom
vim.o.laststatus = 0

-- Spell Check - disabled by default, enabled only for writing filetypes
vim.o.spell = false
vim.o.spelllang = 'en_us'

-- https://github.com/epwalsh/obsidian.nvim?tab=readme-ov-file#concealing-characters
vim.o.conceallevel = 1

-- [[ Basic filetype ]]
--  See `:help filetype`

-- Filetype-specific settings
local filetype_group = vim.api.nvim_create_augroup('FileTypeSettings', { clear = true })

-- Enable spell check for writing-focused filetypes
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'markdown', 'text', 'gitcommit', 'plaintex' },
  group = filetype_group,
  callback = function()
    vim.opt_local.spell = true
  end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'go',
  group = filetype_group,
  callback = function()
    vim.opt_local.tabstop = 4
  end,
})

-- Add *-dockerfile to Dockerfile
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  pattern = '*-dockerfile',
  group = vim.api.nvim_create_augroup('DockerfileDetection', { clear = true }),
  callback = function()
    vim.bo.filetype = 'dockerfile'
  end,
})

-- Direnv .envrc Detection
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  pattern = '.envrc',
  group = vim.api.nvim_create_augroup('EnvrcDetection', { clear = true }),
  callback = function()
    vim.bo.filetype = 'sh'
  end,
})

-- [[ Basic Autocommands ]]
--  See `:help lua-guide-autocommands`

-- Highlight when yanking (copying) text
--  Try it with `yap` in normal mode
--  See `:help vim.hl.on_yank()`
vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking (copying) text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function()
    vim.hl.on_yank()
  end,
})
