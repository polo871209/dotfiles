vim.pack.add {
  'https://github.com/Wansmer/treesj',
  'https://github.com/stevearc/conform.nvim',
}

require('treesj').setup {}
vim.keymap.set('n', '<leader>m', '<cmd>TSJToggle<cr>', { desc = 'Toggle split/join' })

require('conform').setup {
  notify_on_error = false,
  format_on_save = function(bufnr)
    -- Disable for C/C++ (no standard style)
    local disable_filetypes = { c = true, cpp = true }
    local lsp_format_opt
    if disable_filetypes[vim.bo[bufnr].filetype] then
      lsp_format_opt = 'never'
    else
      lsp_format_opt = 'fallback'
    end
    return {
      timeout_ms = 1500,
      lsp_format = lsp_format_opt,
    }
  end,
  formatters_by_ft = {
    bzl = { 'buildifier' },
    cue = { 'cue_fmt' },
    go = { 'goimports' },
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

vim.keymap.set('', '<leader>f', function() require('conform').format { async = true, lsp_format = 'fallback' } end, { desc = '[F]ormat buffer' })
