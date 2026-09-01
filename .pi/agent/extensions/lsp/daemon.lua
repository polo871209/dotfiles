-- Bootstrap for the shared nvim daemons (see nvim.ts). Loaded via --cmd, so
-- before user config: vim.g.pi_agent has to be set here for the plugin/*.lua
-- skip guards, and the timers below must survive a config error rather than
-- depend on it.
--
-- One daemon per lane serves every pi process on the machine, so it owns two
-- jobs no single client can: keeping concurrent clients off each other's toes
-- (guard), and making sure an unused daemon does not sit on a pile of language
-- servers forever (sweep).

vim.g.pi_agent = true
vim.g.pi_daemon = true
-- Identity for this process. Clients key their "already loaded my lua" cache
-- on it, so a restarted daemon can't be mistaken for the one they primed.
vim.g.pi_daemon_epoch = tostring(vim.uv.hrtime())

local D = {}
_G.PiDaemon = D

local SWEEP_MS = tonumber(vim.env.PI_LSP_SWEEP_MS) or (30 * 1000)
-- No connected client for this long: nothing is using the language servers, so
-- exit rather than hold a multi-GB tsserver tree for the next session that may
-- never come. A reconnect costs one cold start.
local IDLE_EXIT_MS = tonumber(vim.env.PI_LSP_IDLE_MS) or (10 * 60 * 1000)
-- A guard held longer than this is treated as leaked (client vanished
-- mid-call), not as a peer still working — otherwise one bad call wedges the
-- daemon for every process on the machine.
local GUARD_STALE_MS = 90 * 1000

local busy = false
local busy_since = 0

-- Driver entrypoints call vim.wait, which pumps the event loop and lets a
-- second client's RPC request start executing inside the first one's wait —
-- two lua chunks interleaving over the same buffer/state. In-process queues
-- can't see across pi processes, so serialization has to live here.
--
-- The loser bounces instead of waiting for its turn. Waiting here deadlocks:
-- the waiter's own vim.wait would run *inside* the holder's, so the holder
-- can't unwind to release until the waiter returns, and the waiter won't
-- return until the holder releases. Bouncing keeps nesting one frame deep and
-- leaves the retry to the client (BUSY_RETRY_MS in nvim.ts).
function D.guard(fn, ...)
    if busy and (vim.uv.now() - busy_since) < GUARD_STALE_MS then return { __pi_busy = true } end
    busy, busy_since = true, vim.uv.now()
    local ok, res = pcall(fn, ...)
    busy = false
    if not ok then error(res, 0) end
    return res
end

local function pid_alive(pid)
    -- Signal 0 probes existence without touching the process.
    local ok = pcall(vim.uv.kill, pid, 0)
    return ok
end

-- Connected pi processes, by pid. Channels are counted only when their owner
-- is still alive: a peer killed hard leaves a half-open channel behind, and
-- counting it would pin the daemon (and every server under it) forever, since
-- the client count is what gates the idle exit. Unattributed channels count as
-- live, so an unidentified client can never be reaped out from under itself.
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

-- Without the sweep there is no idle exit and no gc, so a daemon that can't
-- get a timer is worse than no daemon: fail loudly at startup instead of
-- running as an immortal one.
local sweep = assert(vim.uv.new_timer(), 'pi-lsp daemon: no timer available')
sweep:start(SWEEP_MS, SWEEP_MS, function()
    vim.schedule(function()
        -- Before the busy check: a driver call's vim.wait pumps these timers,
        -- so skipping the stamp while busy lets a long run age the daemon into
        -- "idle" and kill it the moment its last client leaves.
        local connected = D.client_count() > 0
        if connected then last_client_at = vim.uv.now() end
        if busy then return end
        if connected then
            if _G.PiLsp and _G.PiLsp.gc then pcall(_G.PiLsp.gc) end
        elseif vim.uv.now() - last_client_at > IDLE_EXIT_MS then
            vim.cmd 'qall!'
        end
    end)
end)
