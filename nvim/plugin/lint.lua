vim.pack.add { 'https://github.com/mfussenegger/nvim-lint' }

local lint = require 'lint'

-- semgrep: free SAST. `--config auto` pulls registry rules (cached after first
-- fetch). Not built into nvim-lint, so define it.
local semgrep_sev = {
    ERROR = vim.diagnostic.severity.ERROR,
    WARNING = vim.diagnostic.severity.WARN,
    INFO = vim.diagnostic.severity.INFO,
}
lint.linters.semgrep = {
    cmd = 'semgrep',
    stdin = false,
    append_fname = true,
    args = { '--json', '--quiet', '--config', 'auto' },
    stream = 'stdout',
    ignore_exitcode = true,
    parser = function(output, _)
        local diagnostics = {}
        local ok, decoded = pcall(vim.json.decode, output)
        if not ok or not decoded then return diagnostics end
        for _, r in ipairs(decoded.results or {}) do
            table.insert(diagnostics, {
                source = 'semgrep',
                message = r.extra and r.extra.message or r.check_id,
                code = r.check_id,
                lnum = (r.start and r.start.line or 1) - 1,
                col = (r.start and r.start.col or 1) - 1,
                end_lnum = (r['end'] and r['end'].line or 1) - 1,
                end_col = (r['end'] and r['end'].col or 1) - 1,
                severity = (r.extra and semgrep_sev[r.extra.severity]) or vim.diagnostic.severity.WARN,
            })
        end
        return diagnostics
    end,
}

-- zlint: third-party Zig linter with its own semantic analyzer (zls/ast-check
-- only catch syntax + compile errors). Catches unsafe undefined, swallowed
-- errors, dead decls, no-print, etc. NDJSON output, one object per line.
local zlint_sev = {
    err = vim.diagnostic.severity.ERROR,
    error = vim.diagnostic.severity.ERROR,
    warn = vim.diagnostic.severity.WARN,
    warning = vim.diagnostic.severity.WARN,
    info = vim.diagnostic.severity.INFO,
}
lint.linters.zlint = {
    -- zlint (v0.8.1) emits nothing for absolute paths, so cd into the file's
    -- dir and pass its basename. Wrap in sh to make that hermetic regardless
    -- of nvim's cwd.
    cmd = 'sh',
    stdin = false,
    append_fname = false,
    args = {
        '-c',
        'cd "$(dirname "$1")" && zlint --format json "$(basename "$1")"',
        'sh',
        function() return vim.api.nvim_buf_get_name(0) end,
    },
    stream = 'stdout',
    ignore_exitcode = true,
    parser = function(output, _)
        local diagnostics = {}
        for line in vim.gsplit(output, '\n', { trimempty = true }) do
            local ok, d = pcall(vim.json.decode, line)
            if ok and d and d.labels and d.labels[1] then
                local s = d.labels[1].start or {}
                local e = d.labels[1]['end'] or {}
                table.insert(diagnostics, {
                    source = 'zlint',
                    code = d.code,
                    message = type(d.help) == 'string' and (d.message .. '\n' .. d.help) or d.message,
                    lnum = (s.line or 1) - 1,
                    col = (s.column or 1) - 1,
                    end_lnum = (e.line or s.line or 1) - 1,
                    end_col = (e.column or s.column or 1) - 1,
                    severity = zlint_sev[d.level] or vim.diagnostic.severity.WARN,
                })
            end
        end
        return diagnostics
    end,
}

lint.linters_by_ft = {
    dockerfile = { 'hadolint' },
    go = { 'golangcilint', 'semgrep' },
    python = { 'ruff', 'semgrep' },
    terraform = { 'tflint' },
    typescript = { 'eslint_d', 'semgrep' },
    zig = { 'zlint' },
}

-- Global hadolint ignores (DL3007: latest tag)
lint.linters.hadolint.args = vim.list_extend(vim.deepcopy(lint.linters.hadolint.args or {}), { '--ignore', 'DL3007' })

-- semgrep is too slow (network) to run on every keystroke pause; gate it to
-- save. Fast linters run on read/save/InsertLeave as usual.
local SLOW_LINTERS = { semgrep = true }

local function lint_buf(on_save)
    if not vim.bo.modifiable then return end
    local names = lint.linters_by_ft[vim.bo.filetype]
    if not names then return end
    -- On save run everything (except under headless agent nvim, whose
    -- lsp-feedback loop drives diagnostics on its own cadence). Otherwise
    -- skip slow (network) linters.
    if not (on_save and not vim.g.pi_agent) then names = vim.tbl_filter(function(n) return not SLOW_LINTERS[n] end, names) end
    if #names > 0 then lint.try_lint(names) end
end

local lint_augroup = vim.api.nvim_create_augroup('lint', { clear = true })
vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWritePost', 'InsertLeave' }, {
    group = lint_augroup,
    callback = function(args) lint_buf(args.event == 'BufWritePost') end,
})
