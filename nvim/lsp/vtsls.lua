local ts_project = require 'ts_project'

local CRASH_LIMIT = 4
local CRASH_WINDOW_MS = 60 * 1000

local crash_looped_roots = {}
local crash_times = {}

-- vtsls gives up on tsserver only after 5 crashes that each come within 10 s
-- of a start. A tsserver that runs out of heap after 10 s restarts forever.
local function stop_on_crash_loop(err, result, ctx)
    vim.lsp.handlers['window/logMessage'](err, result, ctx)
    local message = result and result.message or ''
    if not message:find '^TSServer exited' or message:find 'Code: 0%.' then return end

    local now = vim.uv.now()
    local recent = vim.tbl_filter(function(t) return now - t < CRASH_WINDOW_MS end, crash_times[ctx.client_id] or {})
    table.insert(recent, now)
    crash_times[ctx.client_id] = recent
    if #recent < CRASH_LIMIT then return end

    local client = vim.lsp.get_client_by_id(ctx.client_id)
    if not client then return end
    crash_times[ctx.client_id] = nil
    if client.root_dir then crash_looped_roots[client.root_dir] = true end
    vim.schedule(function()
        client:stop(true)
        vim.notify(
            ('vtsls stopped for %s: tsserver crashed %d times in %d s'):format(client.root_dir or 'single file', #recent, CRASH_WINDOW_MS / 1000),
            vim.log.levels.WARN
        )
    end)
end

return {
    cmd = { 'vtsls', '--stdio' },
    filetypes = { 'typescript', 'typescriptreact', 'javascript', 'javascriptreact' },
    root_dir = function(bufnr, on_dir)
        local root = ts_project.root(bufnr)
        if root and (crash_looped_roots[root] or ts_project.is_native(root)) then return end
        on_dir(root)
    end,
    init_options = { hostInfo = 'neovim' },
    handlers = { ['window/logMessage'] = stop_on_crash_loop },
    -- vtsls bundles its own TypeScript and prefers it, so a project pinned to
    -- an older version gets diagnostics its own compiler would not produce.
    -- autoUseWorkspaceTsdk alone does nothing: typescript.tsdk still has to
    -- name the workspace copy, and a static relative path makes vtsls warn and
    -- fall back on every project without one, hence the probe. Mutation is
    -- safe because nvim copies the config per root, and before_init is the
    -- last hook before nvim pushes the settings.
    before_init = function(_, config)
        local lib = config.root_dir and vim.fs.joinpath(config.root_dir, 'node_modules', 'typescript', 'lib')
        if lib and vim.uv.fs_stat(vim.fs.joinpath(lib, 'tsserver.js')) then config.settings.typescript.tsdk = lib end
    end,
    settings = {
        vtsls = { autoUseWorkspaceTsdk = true },
        typescript = {
            tsserver = { experimental = { enableProjectDiagnostics = not vim.g.pi_agent } },
        },
    },
}
