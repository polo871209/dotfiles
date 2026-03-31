vim.pack.add {
  'https://github.com/mason-org/mason.nvim',
  'https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim',
  'https://github.com/j-hui/fidget.nvim',
  'https://github.com/b0o/SchemaStore.nvim',
}

require('mason').setup {}
require('fidget').setup {}

-- Global fallback root marker for all servers
vim.lsp.config('*', {
  root_markers = { '.git' },
})

-- LspAttach: behaviour beyond Neovim defaults
-- Neovim 0.11+ already maps globally: grn, gra, grr, gri, grt, K
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
  callback = function(ev)
    local client = vim.lsp.get_client_by_id(ev.data.client_id)

    -- Highlight references to symbol under cursor
    if client and client:supports_method('textDocument/documentHighlight', ev.buf) then
      local hl_group = vim.api.nvim_create_augroup('lsp-highlight', { clear = false })
      vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
        buffer = ev.buf,
        group = hl_group,
        callback = vim.lsp.buf.document_highlight,
      })
      vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
        buffer = ev.buf,
        group = hl_group,
        callback = vim.lsp.buf.clear_references,
      })
      vim.api.nvim_create_autocmd('LspDetach', {
        group = vim.api.nvim_create_augroup('lsp-detach', { clear = true }),
        callback = function(ev2)
          vim.lsp.buf.clear_references()
          vim.api.nvim_clear_autocmds { group = 'lsp-highlight', buffer = ev2.buf }
        end,
      })
    end

    -- Toggle inlay hints
    if client and client:supports_method('textDocument/inlayHint', ev.buf) then
      vim.keymap.set(
        'n',
        '<leader>th',
        function() vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled { bufnr = ev.buf }) end,
        { buffer = ev.buf, desc = 'LSP: [T]oggle Inlay [H]ints' }
      )
    end
  end,
})

-- Diagnostic configuration
vim.diagnostic.config {
  update_in_insert = false,
  severity_sort = true,
  float = { source = 'if_many' },
  underline = { severity = vim.diagnostic.severity.ERROR },
  virtual_text = true,
  virtual_lines = false,
  jump = { float = true },
}

vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostic [Q]uickfix list' })

-- Enable servers (each configured in nvim/lsp/<name>.lua)
vim.lsp.enable {
  'bashls',
  'clangd',
  'cue',
  'gopls',
  'jsonls',
  'jsonnet_ls',
  'lua_ls',
  'nushell',
  'starpls',
  'taplo',
  'terraformls',
  'ty',
  'vtsls',
  'yamlls',
}

-- Ensure non-LSP Mason packages are installed
-- (LSP servers are auto-discovered from lsp/*.lua via vim.lsp.enable)
require('mason-tool-installer').setup {
  ensure_installed = {
    'delve',
    'buildifier',
    'hadolint',
    'stylua',
    'prettier',
  },
}
