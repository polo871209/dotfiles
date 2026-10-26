local M = {}
_G.PiFeedback = M

local CODEACTION_TIMEOUT_MS = 2000
local PER_FILE_BUDGET_MS = 4500
local SETTLE_MS = 1000

local FIXALL_KINDS = {
    'source.fixAll',
    'source.organizeImports',
}

local function edit_is_single_file(workspace_edit, self_file)
    local function same(uri) return uri ~= nil and vim.uri_to_fname(uri) == self_file end
    if workspace_edit.documentChanges then
        for _, change in ipairs(workspace_edit.documentChanges) do
            if not (change.textDocument and same(change.textDocument.uri)) then return false end
        end
        return true
    elseif workspace_edit.changes then
        for uri, _ in pairs(workspace_edit.changes) do
            if not same(uri) then return false end
        end
        return true
    end
    return false
end

local function apply_code_actions(bufnr, remaining)
    local clients = vim.lsp.get_clients { bufnr = bufnr }
    if #clients == 0 then return false end
    local self_file = vim.api.nvim_buf_get_name(bufnr)
    local changed = false
    -- Whole-buffer range. Cursor-based make_range_params yields (0,0)-(0,0)
    -- in headless nvim, which some servers (vtsls, gopls) honor literally
    -- and then return no actions.
    local last_line = vim.api.nvim_buf_line_count(bufnr)
    local full_range = {
        start = { line = 0, character = 0 },
        ['end'] = { line = last_line, character = 0 },
    }
    for _, client in ipairs(clients) do
        local enc = client.offset_encoding or 'utf-16'
        for _, kind in ipairs(FIXALL_KINDS) do
            local params = {
                textDocument = vim.lsp.util.make_text_document_params(bufnr),
                range = full_range,
            }
            params.context = { only = { kind }, diagnostics = vim.diagnostic.get(bufnr) or {} }
            local timeout = math.min(CODEACTION_TIMEOUT_MS, remaining())
            if timeout <= 0 then break end
            local ok, results = pcall(vim.lsp.buf_request_sync, bufnr, 'textDocument/codeAction', params, timeout)
            if ok and results then
                for _, res in pairs(results) do
                    for _, action in ipairs(res.result or {}) do
                        if action.edit and edit_is_single_file(action.edit, self_file) then
                            pcall(vim.lsp.util.apply_workspace_edit, action.edit, enc)
                            changed = true
                        end
                    end
                end
            end
        end
    end
    return changed
end

local function try_format(bufnr, budget_ms)
    local ok, autoformat = pcall(require, 'autoformat')
    return ok and autoformat.format(bufnr, budget_ms)
end

local function pull_diagnostics(bufnr)
    local method = vim.lsp.protocol.Methods.textDocument_diagnostic
    for _, client in ipairs(vim.lsp.get_clients { bufnr = bufnr, method = method }) do
        local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
        pcall(client.request, client, method, params, nil, bufnr)
    end
end

local function touch(bufnr)
    if _G.PiDaemon and _G.PiDaemon.touch then _G.PiDaemon.touch(bufnr) end
end

local function dedupe_files(files)
    local seen = {}
    local out = {}
    for _, f in ipairs(files) do
        if type(f) == 'string' and not seen[f] then
            seen[f] = true
            table.insert(out, f)
        end
    end
    return out
end

function M.format(files, timeout_ms)
    local formatted = {}
    for _, file in ipairs(dedupe_files(files)) do
        if vim.uv.fs_stat(file) then
            vim.cmd('silent! edit ' .. vim.fn.fnameescape(file))
            local bufnr = vim.api.nvim_get_current_buf()
            touch(bufnr)
            pcall(function() vim.cmd 'filetype detect' end)
            if try_format(bufnr, timeout_ms) then
                pcall(function()
                    vim.api.nvim_buf_call(bufnr, function() vim.cmd 'silent! write' end)
                end)
                table.insert(formatted, vim.api.nvim_buf_get_name(bufnr))
            end
        end
    end
    return { formatted = formatted }
end

function M.run(files)
    local formatted = {}
    local bufs = {}

    for _, file in ipairs(dedupe_files(files)) do
        if vim.uv.fs_stat(file) then
            local file_started = vim.uv.now()
            local function remaining() return math.max(0, PER_FILE_BUDGET_MS - (vim.uv.now() - file_started)) end
            vim.cmd('silent! edit ' .. vim.fn.fnameescape(file))
            local bufnr = vim.api.nvim_get_current_buf()
            touch(bufnr)
            table.insert(bufs, bufnr)

            pcall(function() vim.cmd 'filetype detect' end)
            pcall(function() vim.cmd 'doautocmd BufRead' end)
            pcall(function() vim.cmd 'doautocmd BufEnter' end)
            pcall(function() vim.cmd 'doautocmd FileType' end)

            vim.wait(math.min(2000, remaining()), function() return #vim.lsp.get_clients { bufnr = bufnr } > 0 end, 50)

            pull_diagnostics(bufnr)
            vim.wait(math.min(800, remaining()), function() return false end, 50)

            local fixed = apply_code_actions(bufnr, remaining)
            local refmt = try_format(bufnr, remaining())
            if fixed or refmt then pcall(function()
                vim.api.nvim_buf_call(bufnr, function() vim.cmd 'silent! write' end)
            end) end
            if fixed or refmt then table.insert(formatted, vim.api.nvim_buf_get_name(bufnr)) end

            pull_diagnostics(bufnr)
        end
    end

    vim.wait(SETTLE_MS, function() return false end, 50)

    local out = { formatted = formatted, diagnostics = {} }
    local sev = { 'error', 'warn', 'info', 'hint' }
    for _, bufnr in ipairs(bufs) do
        if vim.api.nvim_buf_is_valid(bufnr) then
            for _, d in ipairs(vim.diagnostic.get(bufnr)) do
                table.insert(out.diagnostics, {
                    file = vim.api.nvim_buf_get_name(bufnr),
                    line = (d.lnum or 0) + 1,
                    col = (d.col or 0) + 1,
                    severity = sev[d.severity] or 'info',
                    source = d.source,
                    code = d.code and tostring(d.code) or nil,
                    message = (d.message or ''):gsub('\r?\n', ' '),
                })
            end
        end
    end
    return out
end

return true
