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
vim.o.scrolloff = 30

-- Disable line wrap
vim.o.wrap = false

-- Hide status line
vim.o.laststatus = 0

-- Default border for all floating windows (nvim 0.12+)
vim.o.winborder = 'rounded'

-- Hide command line
vim.o.cmdheight = 0

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
  callback = function()
    vim.opt_local.tabstop = 4
    vim.opt_local.shiftwidth = 4
  end,
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

vim.api.nvim_create_autocmd('FileType', {
  pattern = { 'c', 'cpp' },
  group = filetype_group,
  callback = function()
    vim.opt_local.tabstop = 4
    vim.opt_local.shiftwidth = 4
    vim.opt_local.expandtab = true
  end,
})

-- Filetype detection
vim.filetype.add {
  filename = {
    ['.envrc'] = 'sh',
    ['BUILD'] = 'bzl',
    ['BUILD.bazel'] = 'bzl',
    ['WORKSPACE'] = 'bzl',
    ['WORKSPACE.bazel'] = 'bzl',
    ['MODULE.bazel'] = 'bzl',
  },
  extension = { bzl = 'bzl' },
}

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
