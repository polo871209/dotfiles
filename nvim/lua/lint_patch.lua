-- Per-linter fixups, applied the first time each linter actually runs.
--
-- They cannot be applied at startup: reading `lint.linters.<name>` requires that
-- linter's module, and some do real work in their body. golangcilint builds its
-- args by shelling out to `golangci-lint version` and `go env GOMOD`, which cost
-- ~50ms of every nvim start for a linter most sessions never run.
--
-- Two callers reach nvim-lint independently -- plugin/lint.lua for interactive
-- nvim and .pi/agent/extensions/lsp/driver.lua for the agent instance -- so both
-- must route through M.apply or the fixups silently never land.

local M = {}

--- Directory of the nearest eslint config. nvim-lint runs eslint_d in nvim's
--- cwd, not the buffer's directory. In a monorepo (config in a subpackage, e.g.
--- apps/web/eslint.config.mjs, not repo root) that cwd has no config in its
--- upward search path, so eslint_d silently reports nothing -- nvim-lint's own
--- parser even swallows the "Could not find config file" error.
---@return string
local function eslint_root()
    local file = vim.api.nvim_buf_get_name(0)
    local found = vim.fs.find(
        { 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc' },
        { path = vim.fs.dirname(file), upward = true }
    )[1]
    return found and vim.fs.dirname(found) or vim.fn.getcwd()
end

---@type table<string, fun(linter: table)>
local patches = {
    golangcilint = function(l)
        if l.args then l.args[#l.args] = function() return vim.fn.fnamemodify(vim.api.nvim_buf_get_name(0), ':h') end end
    end,
    eslint_d = function(l)
        l.cmd = 'sh'
        l.args = {
            '-c',
            'cd "$1" && shift && exec eslint_d "$@"',
            'sh',
            eslint_root,
            '--format',
            'json',
            '--stdin',
            '--stdin-filename',
            function() return vim.api.nvim_buf_get_name(0) end,
        }
    end,
    -- Global hadolint ignores (DL3007: latest tag)
    hadolint = function(l) l.args = vim.list_extend(vim.deepcopy(l.args or {}), { '--ignore', 'DL3007' }) end,
}

--- Patch every named linter that still needs it. Safe to call on every lint.
---@param names string[]
function M.apply(names)
    local ok, lint = pcall(require, 'lint')
    if not ok then return end
    for _, name in ipairs(names) do
        local fn = patches[name]
        if fn then
            patches[name] = nil
            local linter = lint.linters[name]
            if linter then fn(linter) end
        end
    end
end

return M
