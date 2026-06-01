-- lsp-feedback driver — loaded into the persistent --embed nvim that
-- extensions/lsp/ owns. Exposes _G.PiFeedback.run(files) which formats,
-- applies safe LSP code-actions (fixAll, organizeImports), and returns
-- diagnostics. Mirrors the original per-call headless pipeline but reuses
-- the shared nvim so we skip spawn + init.lua load each agent turn.

local M = {}
_G.PiFeedback = M

local FORMAT_TIMEOUT_MS = 3000
local CODEACTION_TIMEOUT_MS = 2000
-- Per-file budget so a slow first file doesn't starve later ones.
-- TS side caps the whole call separately (see nvimCallTimeoutMs).
local PER_FILE_BUDGET_MS = 4500
local SETTLE_MS = 1000

-- Async + network-bound linters don't finish inside the per-file budget, so
-- their diagnostics land after M.run returns (inconsistent + orphan jobs).
-- Skip here; they run on save in interactive nvim (see plugin/lint.lua).
local SLOW_LINTERS = {
    semgrep = true,
}

local function run_fast_lint(bufnr)
    local ok, lint = pcall(require, 'lint')
    if not ok then return end
    local names = lint.linters_by_ft[vim.bo[bufnr].filetype]
    if not names then return end
    local allowed = {}
    for _, name in ipairs(names) do
        if not SLOW_LINTERS[name] then table.insert(allowed, name) end
    end
    if #allowed == 0 then return end
    pcall(function() lint.try_lint(allowed) end)
end

local FIXALL_KINDS = {
    'source.fixAll',
    'source.organizeImports',
}

local function apply_code_actions(bufnr, remaining)
    local clients = vim.lsp.get_clients { bufnr = bufnr }
    if #clients == 0 then return false end
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
                        if action.edit then
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

local function pull_diagnostics(bufnr, remaining)
    local clients = vim.lsp.get_clients { bufnr = bufnr }
    for _, client in ipairs(clients) do
        local caps = client.server_capabilities or {}
        if caps.diagnosticProvider then
            local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
            pcall(vim.lsp.buf_request_sync, bufnr, 'textDocument/diagnostic', params, math.min(1500, remaining()))
        end
    end
end

function M.run(files)
    local formatted = {}
    local bufs = {}

    for _, file in ipairs(files) do
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
