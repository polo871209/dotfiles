-- Frequency + recency per path, persisted under stdpath('data'). A file opened
-- often and recently outranks one opened once, long ago.
--
-- The store is shared by every project, so keys must be absolute: a relative
-- key would make `src/main.rs` the same entry in every repository.

local FILE = vim.fn.stdpath 'data' .. '/picker-frecency.json'
local HALF_LIFE = 30 * 24 * 60 * 60 -- 30 days

---@alias PickerFrecencyEntry { count: integer, last: integer }

---@class PickerFrecency
---@field data table<string, PickerFrecencyEntry>?
---@field dirty boolean
local M = { data = nil, dirty = false }

---@return table<string, PickerFrecencyEntry>
function M.load()
    if M.data then return M.data end
    local data = {}
    local f = io.open(FILE, 'r')
    if f then
        local ok, decoded = pcall(vim.json.decode, f:read 'a')
        f:close()
        if ok and type(decoded) == 'table' then data = decoded end
    end
    M.data = data
    return data
end

---@param path string absolute, or relative to `cwd`
---@param cwd string?
---@return string
local function key(path, cwd)
    if path:sub(1, 1) == '/' then return path end
    return vim.fs.normalize(vim.fs.joinpath(cwd or vim.uv.cwd() or vim.fn.getcwd(), path))
end

---@param entry PickerFrecencyEntry?
---@return number
local function decay(entry)
    if not entry then return 0 end
    local age = os.time() - (entry.last or 0)
    return (entry.count or 1) * 2 ^ (-age / HALF_LIFE)
end

---@param path string
---@param cwd string?
---@return number
function M.score(path, cwd) return decay(M.load()[key(path, cwd)]) end

---@param path string
---@param cwd string?
function M.bump(path, cwd)
    local data = M.load()
    local k = key(path, cwd)
    local entry = data[k] or { count = 0 }
    entry.count = (entry.count or 0) + 1
    entry.last = os.time()
    data[k] = entry
    if not M.dirty then
        M.dirty = true
        vim.schedule(M.save)
    end
end

function M.save()
    M.dirty = false
    if not M.data then return end
    -- Drop entries that have decayed into irrelevance so the store stays small.
    local pruned = {}
    for path, entry in pairs(M.data) do
        if decay(entry) > 0.01 then pruned[path] = entry end
    end
    M.data = pruned
    local f = io.open(FILE, 'w')
    if not f then return end
    f:write(vim.json.encode(pruned))
    f:close()
end

return M
