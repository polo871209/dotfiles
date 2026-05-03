vim.pack.add {
  'https://github.com/mason-org/mason.nvim',
  'https://github.com/WhoIsSethDaniel/mason-tool-installer.nvim',
  'https://github.com/b0o/SchemaStore.nvim',
}

require('mason').setup {}

require('mason-tool-installer').setup {
  -- LSP servers are auto-discovered from lsp/*.lua via vim.lsp.enable
  ensure_installed = {
    'delve',
    'buildifier',
    'hadolint',
    'stylua',
    'prettier',
    'zls',
  },
}

vim.lsp.config('*', {
  root_markers = { '.git' },
})

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
  'zls',
}

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

-- Forwards LSP progress to nvim_echo so it integrates with the ghostty status line
vim.api.nvim_create_autocmd('LspProgress', {
  group = vim.api.nvim_create_augroup('lsp-osc-progress', { clear = true }),
  callback = function(ev)
    local value = ev.data.params.value or {}
    local msg = value.message or 'done'

    -- rust-analyzer in particular has really long LSP messages so truncate them
    if #msg > 40 then msg = msg:sub(1, 37) .. '...' end

    -- :h LspProgress
    vim.api.nvim_echo({ { msg } }, false, {
      id = 'lsp',
      kind = 'progress',
      title = value.title,
      source = 'lsp',
      status = value.kind ~= 'end' and 'running' or 'success',
      percent = value.percentage,
    })
  end,
})

-- Organize C/C++ includes on save via clangd's organizeImports code action
vim.api.nvim_create_autocmd('BufWritePre', {
  pattern = { '*.c', '*.cpp', '*.h', '*.hpp' },
  group = vim.api.nvim_create_augroup('clangd-organize-imports', { clear = true }),
  callback = function(ev)
    local client = vim.lsp.get_clients({ bufnr = ev.buf, name = 'clangd' })[1]
    if not client then return end
    local params = vim.tbl_extend('force', vim.lsp.util.make_range_params(0, client.offset_encoding), {
      context = { only = { 'source.organizeImports' }, diagnostics = {} },
    })
    local result = vim.lsp.buf_request_sync(ev.buf, 'textDocument/codeAction', params, 1000)
    for _, res in pairs(result or {}) do
      for _, action in pairs(res.result or {}) do
        if action.edit then
          vim.lsp.util.apply_workspace_edit(action.edit, client.offset_encoding)
        end
      end
    end
  end,
})
