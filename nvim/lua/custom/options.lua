-- Leader key (before plugins load)
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- Line numbers
vim.o.number = true
vim.o.relativenumber = true

-- Enable mouse
vim.o.mouse = 'a'

-- Hide mode display (shown in status line)
vim.o.showmode = false

-- Sync clipboard with OS
vim.schedule(function() vim.o.clipboard = 'unnamedplus' end)

-- Indentation
vim.o.breakindent = true

-- Persistent undo
vim.o.undofile = true

-- Disable swap files
vim.o.swapfile = false

-- Smart case-insensitive search
vim.o.ignorecase = true
vim.o.smartcase = true

-- Always show sign column
vim.o.signcolumn = 'yes'

-- Faster update time
vim.o.updatetime = 250

-- Faster key sequence timeout
vim.o.timeoutlen = 300

-- Split directions
vim.o.splitright = true
vim.o.splitbelow = true

-- Show whitespace characters
vim.o.list = true
vim.opt.listchars = { trail = '·', nbsp = '␣', tab = '» ' }

-- Live substitution preview
vim.o.inccommand = 'split'

-- Highlight cursor line
vim.o.cursorline = true

-- Scroll padding
vim.o.scrolloff = 10

-- Disable line wrap
vim.o.wrap = false

-- Hide status line
vim.o.laststatus = 0

-- Spell check
vim.o.spell = false
vim.o.spelllang = 'en_us'

-- Concealment level for obsidian.nvim
vim.o.conceallevel = 1

-- Filetype-specific settings
local filetype_group = vim.api.nvim_create_augroup('FileTypeSettings', { clear = true })

-- Enable spell check for text files
vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'markdown', 'text', 'gitcommit', 'plaintex' },
  group = filetype_group,
  callback = function() vim.opt_local.spell = true end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'go',
  group = filetype_group,
  callback = function() vim.opt_local.tabstop = 4 end,
})

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'cue',
  group = filetype_group,
  callback = function()
    vim.opt_local.tabstop = 4
    vim.opt_local.shiftwidth = 2
    vim.opt_local.expandtab = false
  end,
})

-- TypeScript/JavaScript indentation (set after other plugins)
vim.api.nvim_create_autocmd({ 'FileType', 'BufEnter' }, {
  group = vim.api.nvim_create_augroup('TSJSIndent', { clear = true }),
  callback = function()
    vim.schedule(function() vim.opt_local.tabstop = 4 end)
  end,
})

-- Dockerfile detection
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  pattern = '*-dockerfile',
  group = vim.api.nvim_create_augroup('DockerfileDetection', { clear = true }),
  callback = function() vim.bo.filetype = 'dockerfile' end,
})

-- Direnv .envrc detection
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  pattern = '.envrc',
  group = vim.api.nvim_create_augroup('EnvrcDetection', { clear = true }),
  callback = function() vim.bo.filetype = 'sh' end,
})

-- Bazel file detection
vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
  pattern = { 'BUILD', 'BUILD.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel', '*.bzl' },
  group = vim.api.nvim_create_augroup('BazelDetection', { clear = true }),
  callback = function() vim.bo.filetype = 'bzl' end,
})

-- Highlight on yank
vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function() vim.hl.on_yank() end,
})

-- Quickfix window height
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'qf',
  group = vim.api.nvim_create_augroup('QuickfixHeight', { clear = true }),
  callback = function()
    local height = math.floor(vim.o.lines * 0.45)
    vim.cmd('resize ' .. height)
  end,
})
