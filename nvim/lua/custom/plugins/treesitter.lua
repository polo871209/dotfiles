return {
  'nvim-treesitter/nvim-treesitter',
  lazy = false,
  build = ':TSUpdate',
  config = function()
    require('nvim-treesitter').setup {
      install_dir = vim.fn.stdpath 'data' .. '/site',
    }

    -- https://github.com/nvim-treesitter/nvim-treesitter/blob/main/SUPPORTED_LANGUAGES.md
    require('nvim-treesitter')
      .install({
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
      })
      :wait(30000)

    -- Enable treesitter highlighting for all filetypes
    vim.api.nvim_create_autocmd('FileType', {
      callback = function()
        local buf = vim.api.nvim_get_current_buf()
        pcall(vim.treesitter.start, buf)
      end,
    })
  end,
}
