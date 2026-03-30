vim.pack.add { 'https://github.com/nvim-treesitter/nvim-treesitter' }

local install_dir = vim.fn.stdpath 'data' .. '/site'
require('nvim-treesitter').setup { install_dir = install_dir }

-- Add bundled queries (highlights.scm etc.) to runtimepath
vim.opt.runtimepath:prepend(vim.fs.joinpath(install_dir, 'pack/core/opt/nvim-treesitter/runtime'))

require('nvim-treesitter').install {
  'bash',
  'c',
  'cue',
  'diff',
  'go',
  'helm',
  'html',
  'javascript',
  'jq',
  'json',
  'jsonnet',
  'just',
  'lua',
  'luadoc',
  'markdown',
  'markdown_inline',
  'nu',
  'python',
  'query',
  'sql',
  'starlark',
  'terraform',
  'toml',
  'typescript',
  'vim',
  'vimdoc',
  'yaml',
}

-- Enable treesitter highlighting for all filetypes
vim.api.nvim_create_autocmd('FileType', {
  callback = function()
    pcall(vim.treesitter.start, vim.api.nvim_get_current_buf())
  end,
})
