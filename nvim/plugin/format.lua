vim.pack.add {
  'https://github.com/Wansmer/treesj',
  'https://github.com/stevearc/conform.nvim',
}

require('treesj').setup { use_default_keymaps = false }
vim.keymap.set('n', '<leader>m', '<cmd>TSJToggle<cr>', { desc = 'Toggle split/join' })

-- Use biome instead of prettier when biome config present in project
local function biome_or_prettier(bufnr)
  if vim.fs.find({ 'biome.json', 'biome.jsonc' }, { upward = true, path = vim.api.nvim_buf_get_name(bufnr) })[1] then return { 'biome' } end
  return { 'prettier' }
end

require('conform').setup {
  notify_on_error = false,
  format_on_save = {
    timeout_ms = 1500,
    lsp_format = 'fallback',
  },
  formatters_by_ft = {
    bzl = { 'buildifier' },
    c = { 'clang-format' },
    cpp = { 'clang-format' },
    css = biome_or_prettier,
    cue = { 'cue_fmt' },
    go = { 'goimports' },
    html = biome_or_prettier,
    javascript = biome_or_prettier,
    javascriptreact = biome_or_prettier,
    json = biome_or_prettier,
    jsonnet = { 'jsonnetfmt' },
    lua = { 'stylua' },
    markdown = biome_or_prettier,
    protobuf = { 'buf' },
    python = { 'ruff_fix', 'ruff_format', 'ruff_organize_imports' },
    terraform = { 'terraform_fmt' },
    typescript = biome_or_prettier,
    typescriptreact = biome_or_prettier,
    yaml = biome_or_prettier,
    zig = { 'zigfmt' },
  },
  formatters = {
    ['clang-format'] = {
      prepend_args = { '--style={BasedOnStyle: Google, IndentWidth: 4, ReflowComments: false}' },
    },
    jsonnetfmt = {
      args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
    },
  },
}

vim.keymap.set('', '<leader>f', function() require('conform').format { async = true, lsp_format = 'fallback' } end, { desc = '[F]ormat buffer' })
