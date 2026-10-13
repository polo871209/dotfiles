local ignore = require 'ignore'

local M = {}

local SKIP_DIRS = {}
for _, dir in ipairs(ignore.dirs) do
    SKIP_DIRS[dir] = true
end

local SKIP_FILES = vim.tbl_map(vim.glob.to_lpeg, ignore.files)

local function rg_globs()
    local globs = {}
    for _, dir in ipairs(ignore.dirs) do
        globs[#globs + 1] = '-g=!' .. dir
        globs[#globs + 1] = '-g=!' .. dir .. '/**'
    end
    for _, file in ipairs(ignore.files) do
        globs[#globs + 1] = '-g=!' .. file
    end
    return globs
end

---@param name string
---@return boolean
function M.executable(name) return vim.fn.executable(name) == 1 end

---@param rel string path relative to the search root
---@param hidden boolean? keep dotfiles and anything inside a dot-directory
---@return boolean
function M.excluded(rel, hidden)
    local parts = vim.split(rel, '/', { plain = true })
    for _, part in ipairs(parts) do
        if SKIP_DIRS[part] or (not hidden and part:sub(1, 1) == '.') then return true end
    end
    local name = parts[#parts]
    for _, glob in ipairs(SKIP_FILES) do
        if glob:match(name) then return true end
    end
    return false
end

---@return string[]?
function M.files()
    if not M.executable 'rg' then return nil end
    local cmd = { 'rg', '--files', '--no-messages', '--color', 'never', '--hidden' }
    vim.list_extend(cmd, rg_globs())
    return cmd
end

---@param query string
---@param opts { hidden: boolean?, ignored: boolean? }
---@return string[]
function M.grep(query, opts)
    local cmd = {
        'rg',
        '--color=never',
        '--no-heading',
        '--with-filename',
        '--line-number',
        '--column',
        '--smart-case',
        '--max-columns=500',
        '--max-columns-preview',
        '--null',
    }
    cmd[#cmd + 1] = opts.hidden and '--hidden' or '--no-hidden'
    if opts.ignored then cmd[#cmd + 1] = '--no-ignore' end
    vim.list_extend(cmd, rg_globs())
    vim.list_extend(cmd, { '--', query })
    return cmd
end

---@param query string regex, as rg takes it
---@param root string real path of the search root
---@param opts { ignored: boolean? }
---@return table
function M.fsearch_grep(query, root, opts)
    return { op = 'grep', pattern = query, mode = 'regex', q = not opts.ignored and '!git:ignored' or nil, ['in'] = root, limit = 2000, per_file = 100 }
end

return M
