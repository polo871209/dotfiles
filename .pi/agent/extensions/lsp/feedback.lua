-- Feedback driver for the lsp subsystem — loaded into the shared --embed nvim.
-- Exposes _G.PiFeedback.format(files) (fast format-only, for the inline
-- per-edit hook) and _G.PiFeedback.run(files) (format + safe LSP code-actions
-- (fixAll, organizeImports) + diagnostics, for the batched turn-end pass).
-- Reuses the shared nvim so we skip spawn + init.lua load each agent turn.

local M = {}
_G.PiFeedback = M

local FORMAT_TIMEOUT_MS = 3000
local CODEACTION_TIMEOUT_MS = 2000
-- Per-file budget so a slow first file doesn't starve later ones.
-- TS side caps the whole call separately (see nvimCallTimeoutMs).
local PER_FILE_BUDGET_MS = 4500
local SETTLE_MS = 1000

-- run_fast_lint + pull_diagnostics live on _G.PiLspShared (driver.lua).
local run_fast_lint = function(bufnr) _G.PiLspShared.run_fast_lint(bufnr) end

local FIXALL_KINDS = {
    'source.fixAll',
    'source.organizeImports',
}

-- Conservative guard: only apply a code-action whose WorkspaceEdit is confined
-- to the current buffer's own file. Anything that would touch another file (or
-- a create/rename/delete file op) is skipped so an on-demand fix never edits
-- code unrelated to the diagnostic.
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

local function try_format(bufnr)
    local ok_conform, conform = pcall(require, 'conform')
    if not ok_conform then return false end
    local before = vim.api.nvim_buf_get_changedtick(bufnr)
    pcall(function() conform.format { bufnr = bufnr, async = false, lsp_format = 'fallback', timeout_ms = FORMAT_TIMEOUT_MS } end)
    return vim.api.nvim_buf_get_changedtick(bufnr) ~= before
end

local function pull_diagnostics(bufnr, remaining) _G.PiLspShared.pull_diagnostics(bufnr, math.min(1500, remaining())) end

-- A repeated path would otherwise open/format/pull-diagnostics twice and
-- double-count that file's diagnostics in the result.
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

-- Fast, format-only pass for the inline (per-edit) hook. Just conform/LSP
-- formatting + write; NO diagnostic settle, NO code-actions (those stay in the
-- batched M.run at turn end). Keeps per-edit latency to a formatter call so the
-- agent's edit result can be amended with the formatted bytes synchronously.
function M.format(files)
    local formatted = {}
    for _, file in ipairs(dedupe_files(files)) do
        if type(file) == 'string' and vim.uv.fs_stat(file) then
            vim.cmd('silent! edit ' .. vim.fn.fnameescape(file))
            local bufnr = vim.api.nvim_get_current_buf()
            pcall(function() vim.cmd 'filetype detect' end)
            if try_format(bufnr) then
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
        if type(file) == 'string' and vim.uv.fs_stat(file) then
            local file_started = vim.uv.now()
            local function remaining() return math.max(0, PER_FILE_BUDGET_MS - (vim.uv.now() - file_started)) end
            vim.cmd('silent! edit ' .. vim.fn.fnameescape(file))
            local bufnr = vim.api.nvim_get_current_buf()
            table.insert(bufs, bufnr)

            pcall(function() vim.cmd 'filetype detect' end)
            pcall(function() vim.cmd 'doautocmd BufRead' end)
            pcall(function() vim.cmd 'doautocmd BufEnter' end)
            pcall(function() vim.cmd 'doautocmd FileType' end)

            -- 1) Format first. conform.nvim uses external formatters so this
            --    runs even if the LSP pipeline later fails/times out.
            local fmt = try_format(bufnr)
            if fmt then
                pcall(function()
                    vim.api.nvim_buf_call(bufnr, function() vim.cmd 'silent! write' end)
                end)
                table.insert(formatted, vim.api.nvim_buf_get_name(bufnr))
            end

            -- 2) Wait LSP attach (best-effort).
            vim.wait(math.min(2000, remaining()), function() return #vim.lsp.get_clients { bufnr = bufnr } > 0 end, 50)

            pull_diagnostics(bufnr, remaining)
            run_fast_lint(bufnr)
            vim.wait(math.min(800, remaining()), function() return false end, 50)

            -- 3) Safe auto-fixes (organizeImports + source.fixAll).
            local fixed = apply_code_actions(bufnr, remaining)
            if fixed then
                local refmt = try_format(bufnr)
                pcall(function()
                    vim.api.nvim_buf_call(bufnr, function() vim.cmd 'silent! write' end)
                end)
                if refmt and not fmt then table.insert(formatted, vim.api.nvim_buf_get_name(bufnr)) end
            end

            pull_diagnostics(bufnr, remaining)
            run_fast_lint(bufnr)
        end
    end

    -- Final settle for async publishDiagnostics.
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
