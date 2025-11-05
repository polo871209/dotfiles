return {
  'nvim-treesitter/nvim-treesitter',
  branch = 'main',
  lazy = false,
  build = ':TSUpdate',
  config = function()
    require('nvim-treesitter').setup({
      install_dir = vim.fn.stdpath('data') .. '/site',
    })

    require('nvim-treesitter').install({
      'bash',
      'c',
      'diff',
      'dockerfile',
      'go',
      'git_config',
      'html',
      'json',
      'lua',
      'luadoc',
      'markdown',
      'markdown_inline',
      'nu',
      'python',
      'query',
      'terraform',
      'toml',
      'vim',
      'vimdoc',
      'yaml',
    })

    -- Enable treesitter highlighting for all filetypes
    vim.api.nvim_create_autocmd('FileType', {
      callback = function()
        local buf = vim.api.nvim_get_current_buf()
        pcall(vim.treesitter.start, buf)
      end,
    })
  end,
}
