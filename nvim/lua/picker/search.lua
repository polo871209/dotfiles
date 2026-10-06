local ignore = require 'ignore'

local M = {}

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

return M
