-- An inherited GOROOT can mismatch the `go` on PATH (e.g. after a version
-- bump) and fail every gopls typecheck. Go finds GOROOT from the binary's own
-- location when unset, so clear it before any server spawns.
if vim.env.GOROOT then vim.env.GOROOT = nil end

vim.g.pi_agent = true
vim.g.pi_daemon = true
vim.g.pi_daemon_epoch = tostring(vim.uv.hrtime())

local D = {}
_G.PiDaemon = D

local SWEEP_MS = tonumber(vim.env.PI_LSP_SWEEP_MS) or (30 * 1000)
local IDLE_EXIT_MS = tonumber(vim.env.PI_LSP_IDLE_MS) or (10 * 60 * 1000)
local GUARD_STALE_MS = 90 * 1000
local MAX_BUFS = tonumber(vim.env.PI_LSP_MAX_BUFS) or 40
local BUF_IDLE_MS = tonumber(vim.env.PI_LSP_BUF_IDLE_MS) or (30 * 60 * 1000)

local busy = false
local busy_since = 0

function D.guard(fn, ...)
    if busy and (vim.uv.now() - busy_since) < GUARD_STALE_MS then return { __pi_busy = true } end
    busy, busy_since = true, vim.uv.now()
    local ok, res = pcall(fn, ...)
    busy = false
    if not ok then error(res, 0) end
    return res
end

local function pid_alive(pid)
    local ok = pcall(vim.uv.kill, pid, 0)
    return ok
end

function D.client_pids()
    local pids, unknown = {}, 0
    for _, ch in ipairs(vim.api.nvim_list_chans()) do
        if ch.stream == 'socket' then
            local pid = tonumber(ch.client and ch.client.attributes and ch.client.attributes.pid)
            if not pid then
                unknown = unknown + 1
            elseif pid_alive(pid) then
                table.insert(pids, pid)
            else
                pcall(vim.fn.chanclose, ch.id)
            end
        end
    end
    return pids, unknown
end

function D.client_count()
    local pids, unknown = D.client_pids()
    return #pids + unknown
end

local started_at = os.time()
local last_client_at = vim.uv.now()

function D.info()
    return {
        pid = vim.uv.os_getpid(),
        epoch = vim.g.pi_daemon_epoch,
        uptime_s = os.time() - started_at,
        clients = D.client_count(),
        client_pids = D.client_pids(),
        rss_mb = math.floor(vim.uv.resident_set_memory() / 1048576),
        busy = busy,
    }
end

local last_used = {}

function D.touch(bufnr) last_used[bufnr] = vim.uv.now() end

local function live_buf_count(client)
    local n = 0
    for bufnr in pairs(client.attached_buffers or {}) do
        if vim.api.nvim_buf_is_valid(bufnr) and vim.api.nvim_buf_is_loaded(bufnr) then n = n + 1 end
    end
    return n
end

function D.gc()
    local now = vim.uv.now()
    local live = {}
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(b) and vim.api.nvim_buf_get_name(b) ~= '' then
            if not last_used[b] then last_used[b] = now end
            table.insert(live, { buf = b, used = last_used[b] })
        end
    end
    for b in pairs(last_used) do
        if not vim.api.nvim_buf_is_valid(b) then last_used[b] = nil end
    end
    table.sort(live, function(a, z) return a.used > z.used end)
    local evicted = 0
    for i, entry in ipairs(live) do
        if i > MAX_BUFS or (now - entry.used) > BUF_IDLE_MS then
            last_used[entry.buf] = nil
            if pcall(vim.api.nvim_buf_delete, entry.buf, { force = true }) then evicted = evicted + 1 end
        end
    end
    local stopped = 0
    for _, c in ipairs(vim.lsp.get_clients()) do
        if live_buf_count(c) == 0 then
            pcall(c.stop, c, false)
            stopped = stopped + 1
        end
    end
    return { evicted = evicted, stopped = stopped, live = #live - evicted }
end

local sweep = assert(vim.uv.new_timer(), 'pi-lsp daemon: no timer available')
sweep:start(SWEEP_MS, SWEEP_MS, function()
    vim.schedule(function()
        local connected = D.client_count() > 0
        if connected then last_client_at = vim.uv.now() end
        if busy then return end
        if connected then
            pcall(D.gc)
        elseif vim.uv.now() - last_client_at > IDLE_EXIT_MS then
            vim.cmd 'qall!'
        end
    end)
end)
