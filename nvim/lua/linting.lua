local M = {}

local SLOW_LINTERS = { semgrep = true }

local ESLINT_CONFIGS =
    { 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc' }
local SQLFLUFF_CONFIGS = { '.sqlfluff', 'pep8.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini' }

---@param bufnr integer
---@return string
local function buf_dir(bufnr) return vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr)) end

-- These linters read their configuration from the working directory, and nvim-lint defaults that to nvim's cwd.
---@type table<string, fun(bufnr: integer): string?>
local cwd_by_linter = {
    eslint_d = function(bufnr) return vim.fs.root(bufnr, ESLINT_CONFIGS) end,
    golangcilint = function(bufnr) return vim.fs.root(bufnr, 'go.mod') or buf_dir(bufnr) end,
    hadolint = function(bufnr) return vim.fs.root(bufnr, { '.hadolint.yaml', '.hadolint.yml' }) or buf_dir(bufnr) end,
    semgrep = function(bufnr) return vim.fs.root(bufnr, '.git') or buf_dir(bufnr) end,
    sqlfluff = function(bufnr) return vim.fs.root(bufnr, SQLFLUFF_CONFIGS) end,
    tflint = function(bufnr) return vim.fs.root(bufnr, '.tflint.hcl') or buf_dir(bufnr) end,
    zlint = function(bufnr) return vim.fs.root(bufnr, { 'zlint.json', 'build.zig' }) or buf_dir(bufnr) end,
}

-- Applied on first use, not at startup: reading `lint.linters.<name>` loads that linter's module, and
-- golangcilint's module shells out to `golangci-lint version` and `go env GOMOD`.
---@type table<string, fun(linter: table)>
local patches = {
    golangcilint = function(l)
        if l.args then l.args[#l.args] = function() return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':h') end end
    end,
    hadolint = function(l)
        local allow_latest_tag = { '--ignore', 'DL3007' }
        l.args = vim.list_extend(vim.deepcopy(l.args or {}), allow_latest_tag)
    end,
    -- Upstream matches tflint's paths, which are relative to the linter's cwd, against the buffer path relative to nvim's cwd.
    tflint = function(l)
        local parse = l.parser
        l.parser = function(output, bufnr, linter_cwd)
            local nvim_cwd = vim.fn.getcwd()
            vim.cmd.cd { linter_cwd, mods = { noautocmd = true } }
            local ok, diagnostics = pcall(parse, output, bufnr, linter_cwd)
            vim.cmd.cd { nvim_cwd, mods = { noautocmd = true } }
            return ok and diagnostics or {}
        end
    end,
}

---@param name string
local function apply_patch(name)
    local patch = patches[name]
    if not patch then return end
    patches[name] = nil
    local linter = require('lint').linters[name]
    if linter then patch(linter) end
end

--- Runs the linters configured for the buffer's filetype, each in the directory that holds its configuration.
---@param bufnr integer
---@param with_slow boolean also run linters too slow for every edit, such as semgrep
function M.run(bufnr, with_slow)
    if not vim.bo[bufnr].modifiable then return end
    local lint = require 'lint'
    local names = lint.linters_by_ft[vim.bo[bufnr].filetype]
    if not names then return end
    -- nvim-lint lints the current buffer and has no bufnr parameter.
    vim.api.nvim_buf_call(bufnr, function()
        for _, name in ipairs(names) do
            if with_slow or not SLOW_LINTERS[name] then
                local cwd_of = cwd_by_linter[name]
                local cwd = cwd_of and cwd_of(bufnr)
                local config_missing = cwd_of and not cwd
                if not config_missing then
                    apply_patch(name)
                    lint.try_lint(name, { cwd = cwd })
                end
            end
        end
    end)
end

return M
