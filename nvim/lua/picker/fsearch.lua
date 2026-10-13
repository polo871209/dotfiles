local SOCKET = vim.fs.joinpath(vim.env.HOME, 'Library/Application Support/FSearch/fsearch.sock')

local M = {}

---@class FsearchRequest
---@field kill fun()

---@param req table
---@param on_reply fun(reply: table?) runs on the main loop, with nil when the daemon is down or answers with an error
---@return FsearchRequest
function M.request(req, on_reply)
    local pipe = assert(vim.uv.new_pipe(false))
    local chunks = {}
    local finished = false
    local function close()
        finished = true
        if not pipe:is_closing() then pipe:close() end
    end
    local function finish(line)
        if finished then return end
        close()
        vim.schedule(function()
            local ok, reply = pcall(vim.json.decode, line or '', { luanil = { object = true, array = true } })
            on_reply(ok and type(reply) == 'table' and reply.ok and reply or nil)
        end)
    end
    pipe:connect(SOCKET, function(connect_err)
        if connect_err then return finish(nil) end
        pipe:write(vim.json.encode(req) .. '\n')
        pipe:read_start(function(read_err, data)
            if read_err or not data then return finish(nil) end
            chunks[#chunks + 1] = data
            if data:find('\n', 1, true) then finish(table.concat(chunks)) end
        end)
    end)
    return { kill = close }
end

---@param root string real path of the folder the picker will search
---@return boolean ready the daemon answers and has finished its first index
function M.ready(root)
    if vim.fn.executable 'fsearch' == 0 then return false end
    local answered, reply = false, nil
    M.request({ op = 'status' }, function(r)
        answered, reply = true, r
    end)
    vim.wait(200, function() return answered end, 1)
    if not reply then
        -- The CLI starts the daemon in its own session when the socket is down, so it outlives nvim.
        vim.system { 'fsearch', 'status' }
        return false
    end
    -- The first `!git:ignored` query in a repo waits for its `git status`, so load it before the first keystroke.
    M.request({ q = '!git:ignored', ['in'] = root, limit = 1 }, function() end)
    return true
end

return M
