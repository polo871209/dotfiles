vim.pack.add { 'https://github.com/nvim-treesitter/nvim-treesitter' }

local install_dir = vim.fn.stdpath 'data' .. '/site'
require('nvim-treesitter').setup { install_dir = install_dir }

-- Add bundled queries (highlights.scm etc.) to runtimepath
vim.opt.runtimepath:prepend(vim.fs.joinpath(install_dir, 'pack/core/opt/nvim-treesitter/runtime'))

local parsers = {
  'bash',
  'c',
  'cpp',
  'css',
  'cue',
  'diff',
  'dockerfile',
  'gitcommit',
  'go',
  'gomod',
  'gosum',
  'gowork',
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
  'regex',
  'scss',
  'sql',
  'starlark',
  'terraform',
  'toml',
  'tsx',
  'typescript',
  'vim',
  'vimdoc',
  'yaml',
}

vim.api.nvim_create_user_command('TSInstallConfigured', function()
  require('nvim-treesitter').install(parsers)
end, { desc = 'Install configured treesitter parsers' })

local function missing_parsers()
  local missing = {}
  for _, parser in ipairs(parsers) do
    if not pcall(vim.treesitter.language.add, parser) then table.insert(missing, parser) end
  end
  return missing
end

vim.api.nvim_create_user_command('TSHealthConfigured', function()
  local missing = missing_parsers()

  if #missing == 0 then
    vim.notify('All configured treesitter parsers available')
  else
    vim.notify('Missing treesitter parsers: ' .. table.concat(missing, ', '), vim.log.levels.WARN)
  end
end, { desc = 'Check configured treesitter parsers' })

vim.defer_fn(function()
  local missing = missing_parsers()
  if #missing > 0 then require('nvim-treesitter').install(missing) end
end, 1000)

local max_filesize = 1024 * 1024
local max_lines = 20000

local function should_start(buf)
  if vim.bo[buf].buftype ~= '' then return false end
  if vim.bo[buf].filetype == '' then return false end
  if vim.api.nvim_buf_line_count(buf) > max_lines then return false end

  local name = vim.api.nvim_buf_get_name(buf)
  if name == '' then return true end

  local stat = vim.uv.fs_stat(name)
  return not stat or stat.size <= max_filesize
end

vim.api.nvim_create_autocmd('FileType', {
  callback = function(ev)
    if should_start(ev.buf) then pcall(vim.treesitter.start, ev.buf) end
  end,
})
