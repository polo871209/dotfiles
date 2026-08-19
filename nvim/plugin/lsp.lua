vim.pack.add {
    'https://github.com/b0o/SchemaStore.nvim',
}

-- LSPs/tools installed via mise (see mise/config.toml)
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
    'pyrefly',
    'starpls',
    'taplo',
    'terraformls',
    'vtsls',
    'yamlls',
    'zls',
}

-- Neovim 0.11+ maps grn, gra, grr, gri, grt, grx, gO and K globally, and sets
-- 'tagfunc' so <C-]> jumps to the definition. Those stay as shipped; anything
-- added here keeps the gr prefix so no default has to be deleted. Jumps land
-- on the target directly when there is one result, otherwise in the quickfix
-- list, which after/ftplugin/qf.lua sizes and closes on <CR>.
vim.keymap.set('n', 'grd', vim.lsp.buf.definition, { desc = 'LSP: Goto Definition' })
vim.keymap.set('n', 'grD', vim.lsp.buf.declaration, { desc = 'LSP: Goto Declaration' })

local hl_group = vim.api.nvim_create_augroup('lsp-highlight', { clear = true })
local detach_group = vim.api.nvim_create_augroup('lsp-detach', { clear = true })

vim.api.nvim_create_autocmd('LspDetach', {
    group = detach_group,
    callback = function(ev)
        vim.lsp.buf.clear_references()
        vim.api.nvim_clear_autocmds { group = hl_group, buffer = ev.buf }
    end,
})

vim.api.nvim_create_autocmd('LspAttach', {
    group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
    callback = function(ev)
        local client = vim.lsp.get_client_by_id(ev.data.client_id)

        if client and client:supports_method('textDocument/documentHighlight', ev.buf) then
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
        end

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

-- gf follows links/files under the cursor and pushes the tagstack so <C-t>
-- jumps back: file://...#Lnnn doc-links (e.g. ZLS hover -> std source) read
-- straight out of the hover float, and plain/relative paths via native gF.
local function push_tag()
    local win = vim.api.nvim_get_current_win()
    local pos = vim.api.nvim_win_get_cursor(win)
    local from = { vim.api.nvim_get_current_buf(), pos[1], pos[2] + 1, 0 }
    vim.fn.settagstack(win, { items = { { tagname = vim.fn.expand '<cword>', from = from } } }, 't')
end

local function follow_file_link(text)
    local url = text:match 'file://([^%s)%]>"\']+)'
    if not url then return false end
    local path, lnum = url:match '^(.-)#L(%d+)$'
    push_tag()
    vim.cmd.edit(vim.uri_decode(path or url))
    if lnum then pcall(vim.api.nvim_win_set_cursor, 0, { tonumber(lnum), 0 }) end
    return true
end

vim.keymap.set('n', 'gf', function()
    -- 1. file:// link inside the open hover float (no need to enter it)
    local fwin = vim.b.lsp_floating_preview
    if fwin and vim.api.nvim_win_is_valid(fwin) then
        local text = table.concat(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(fwin), 0, -1, false), '\n')
        if text:match 'file://' then
            vim.api.nvim_win_close(fwin, true)
            vim.b.lsp_floating_preview = nil
            if follow_file_link(text) then return end
        end
    end
    -- 2. file:// link on the current line
    if follow_file_link(vim.api.nvim_get_current_line()) then return end
    -- 3. plain/relative file under cursor (gF honors a trailing :line). Push
    --    the tagstack, rolling back if gF can't open anything.
    local win = vim.api.nvim_get_current_win()
    local saved = vim.fn.gettagstack(win)
    push_tag()
    if not pcall(function() vim.cmd 'normal! gF' end) then
        vim.fn.settagstack(win, saved, 'r')
        vim.cmd 'normal! gf' -- surface the native "can't find file" error
    end
end, { desc = 'Follow link / file under cursor' })

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
