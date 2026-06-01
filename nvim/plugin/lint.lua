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

lint.linters_by_ft = {
    dockerfile = { 'hadolint' },
    go = { 'golangcilint', 'semgrep' },
    python = { 'ruff', 'semgrep' },
    terraform = { 'tflint' },
    typescript = { 'eslint_d', 'semgrep' },
}

-- Global hadolint ignores (DL3007: latest tag)
lint.linters.hadolint.args = vim.list_extend(vim.deepcopy(lint.linters.hadolint.args or {}), { '--ignore', 'DL3007' })

-- semgrep is too slow (network) to run on every keystroke pause; gate it to
-- save. Fast linters run on read/save/InsertLeave as usual.
local SLOW_LINTERS = { semgrep = true }

local function lint_buf(on_save)
    if not vim.bo.modifiable then return end
    -- Slow linters run only on save, and never under the headless agent nvim
    -- (its lsp-feedback loop handles diagnostics on its own cadence).
    if on_save and not vim.g.pi_agent then
        lint.try_lint()
        return
    end
    local names = lint.linters_by_ft[vim.bo.filetype]
    if not names then return end
    local fast = vim.tbl_filter(function(n) return not SLOW_LINTERS[n] end, names)
    if #fast > 0 then lint.try_lint(fast) end
end

local lint_augroup = vim.api.nvim_create_augroup('lint', { clear = true })
vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWritePost', 'InsertLeave' }, {
    group = lint_augroup,
    callback = function(args) lint_buf(args.event == 'BufWritePost') end,
})
