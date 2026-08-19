-- External search tools: flag construction and the shared ignore list, kept out
-- of the pickers that spawn them.

local ignore = require 'ignore'

local M = {}

-- ripgrep prunes a directory when its basename matches, but a trailing-glob
-- form is needed for patterns used against nested paths.
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

local function fd_excludes()
    local args = {}
    for _, pat in ipairs(ignore.patterns) do
        args[#args + 1] = '-E'
        args[#args + 1] = pat
    end
    return args
end

---@param name string
---@return boolean
function M.executable(name) return vim.fn.executable(name) == 1 end

--- Command listing every file under cwd, or nil when neither tool is installed.
---@return string[]?
function M.files()
    if M.executable 'fd' then
        local cmd = { 'fd', '--type', 'f', '--type', 'l', '--color', 'never', '--hidden' }
        vim.list_extend(cmd, fd_excludes())
        return cmd
    end
    if M.executable 'rg' then
        local cmd = { 'rg', '--files', '--no-messages', '--color', 'never', '--hidden' }
        vim.list_extend(cmd, rg_globs())
        return cmd
    end
    return nil
end

--- Single ripgrep run for `query`, emitting NUL-terminated paths.
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
        -- Without a cap a single minified file can emit a multi-megabyte line
        -- and stall the whole picker.
        '--max-columns=500',
        '--max-columns-preview',
        '--null',
    }
    cmd[#cmd + 1] = opts.hidden and '--hidden' or '--no-hidden'
    -- Off by default: descending into gitignored trees (node_modules, generated
    -- logs) costs ~10x for results nobody wants.
    if opts.ignored then cmd[#cmd + 1] = '--no-ignore' end
    vim.list_extend(cmd, rg_globs())
    vim.list_extend(cmd, { '--', query })
    return cmd
end

return M
