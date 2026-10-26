local M = {}

M.on_save = not vim.g.pi_agent

local IGNORED_PATTERNS = { '/node_modules/', '/%.agents/skills/', '%.lock$' }
local SLOW_FILETYPES = { sql = true }

---@param bufnr integer
---@return boolean
function M.ignored(bufnr)
    local path = vim.api.nvim_buf_get_name(bufnr)
    for _, pattern in ipairs(IGNORED_PATTERNS) do
        if path:match(pattern) then return true end
    end
    return false
end

---@param bufnr integer
---@return boolean
function M.slow(bufnr) return SLOW_FILETYPES[vim.bo[bufnr].filetype] == true end

--- Formats the buffer the way a save does, but synchronously: a slow filetype gets `budget_ms` instead of
--- running after the save.
---@param bufnr integer
---@param budget_ms integer? upper bound for the formatter run
---@return boolean changed
function M.format(bufnr, budget_ms)
    if M.ignored(bufnr) then return false end
    local conform = require 'conform'
    local timeout_ms = conform.default_format_opts.timeout_ms
    if M.slow(bufnr) or not timeout_ms then
        timeout_ms = budget_ms
    elseif budget_ms then
        timeout_ms = math.min(timeout_ms, budget_ms)
    end
    local before = vim.api.nvim_buf_get_changedtick(bufnr)
    pcall(conform.format, { bufnr = bufnr, timeout_ms = timeout_ms })
    return vim.api.nvim_buf_get_changedtick(bufnr) ~= before
end

return M
