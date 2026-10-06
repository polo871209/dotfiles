-- They cannot be applied at startup: reading `lint.linters.<name>` requires that
-- linter's module, and some do real work in their body. golangcilint builds its
-- args by shelling out to `golangci-lint version` and `go env GOMOD`, which cost
-- ~50ms of every nvim start for a linter most sessions never run.
local M = {}

--- Directory of the nearest eslint config, or nil when the buffer has none.
--- nvim-lint runs eslint_d in nvim's cwd, not the buffer's directory. In a
--- monorepo (config in a subpackage, e.g. apps/web/eslint.config.mjs, not repo
--- root) that cwd has no config in its upward search path, so eslint_d silently
--- reports nothing -- nvim-lint's own parser even swallows the "Could not find
--- config file" error.
---@param bufnr integer?
---@return string?
local function eslint_root(bufnr)
    local file = vim.api.nvim_buf_get_name(bufnr or 0)
    if file == '' then return nil end
    local found = vim.fs.find(
        { 'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc' },
        { path = vim.fs.dirname(file), upward = true }
    )[1]
    return found and vim.fs.dirname(found) or nil
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
            function() return eslint_root() or vim.fn.getcwd() end,
            '--format',
            'json',
            '--stdin',
            '--stdin-filename',
            function() return vim.api.nvim_buf_get_name(0) end,
        }
    end,
    hadolint = function(l)
        local allow_latest_tag = { '--ignore', 'DL3007' }
        l.args = vim.list_extend(vim.deepcopy(l.args or {}), allow_latest_tag)
    end,
}

---@type table<string, fun(bufnr: integer?): boolean>
local runnable = {
    -- eslint_d is a daemon shared across projects, and the agent's nvim roams
    -- across projects too, so neither end can be trusted to sit in the right
    -- directory. Without a config of its own, a buffer gets an answer from
    -- whichever project started the daemon: "File ignored because outside of
    -- base path" on line 1 of every file, or "Could not find config file".
    eslint_d = function(bufnr) return eslint_root(bufnr) ~= nil end,
}

--- Drop the linters that cannot run for this buffer. Call before M.apply.
---@param names string[]
---@param bufnr integer?
---@return string[]
function M.filter(names, bufnr)
    return vim.tbl_filter(function(name)
        local can_run = runnable[name]
        return not can_run or can_run(bufnr)
    end, names)
end

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
