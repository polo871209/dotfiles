return {
  -- Split/join code blocks (arrays, functions, etc.)
  {
    'Wansmer/treesj',
    keys = {
      { '<leader>m', '<cmd>TSJToggle<cr>', desc = 'Toggle split/join' },
    },
    dependencies = { 'nvim-treesitter/nvim-treesitter' },
    config = function()
      require('treesj').setup({})
    end,
  },
  {
    'stevearc/conform.nvim',
    event = { 'BufWritePre' },
    cmd = { 'ConformInfo' },
    keys = {
      {
        '<leader>f',
        function()
          require('conform').format({ async = true, lsp_format = 'fallback' })
        end,
        mode = '',
        desc = '[F]ormat buffer',
      },
    },
    opts = {
      notify_on_error = false,
      format_on_save = function(bufnr)
        -- Disable "format_on_save lsp_fallback" for languages that don't
        -- have a well standardized coding style. You can add additional
        -- languages here or re-enable it for the disabled ones.
        local disable_filetypes = { c = true, cpp = true }
        local lsp_format_opt
        if disable_filetypes[vim.bo[bufnr].filetype] then
          lsp_format_opt = 'never'
        else
          lsp_format_opt = 'fallback'
        end
-- Don't load formatters in practice mode
if vim.g.practice_mode then
  return {}
end

return {
          timeout_ms = 1500,
          lsp_format = lsp_format_opt,
        }
      end,
      formatters_by_ft = {
        bzl = { 'buildifier' },
        cue = { 'cue_fmt' },
        go = { 'gofmt' },
        html = { 'prettier' },
        json = { 'prettier' },
        jsonnet = { 'jsonnetfmt' },
        lua = { 'stylua' },
        markdown = { 'prettier' },
        protobuf = { 'buf' },
        python = {
          'ruff_fix',
          'ruff_format',
          'ruff_organize_imports',
        },
        terraform = { 'terraform_fmt' },
        yaml = { 'prettier' },
      },
      formatters = {
        jsonnetfmt = {
          args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
        },
      },
    }
  },
}
