local terminal = 'com.superlogical.terminal'
local home = os.getenv 'HOME'
-- The Rex server's PATH has no mise shims.
local shims = home .. '/.local/share/mise/shims/'
local zoxide = shims .. 'zoxide'
local config_dir = (os.getenv 'XDG_CONFIG_HOME' or home .. '/.config') .. '/rex'

local function must(result, err)
    if err ~= nil then error(err, 0) end
    return result
end

local function exec_stdout(argv, opts)
    local result = must(rex.exec(argv, opts))
    if not result.ok then error(result.stderr, 0) end
    return result.stdout
end

local function tilde_path(dir)
    local path = dir:gsub('(.)/+$', '%1')
    if path == home or path:sub(1, #home + 1) == home .. '/' then return '~' .. path:sub(#home + 1) end
    return path
end

local function shell_block(spec)
    return rex.layout.block { flavor = terminal .. '.shell', label = spec.label, options = { cwd = spec.cwd, command = spec.command } }
end

local function process(ctx) return must(rex.block.call(terminal, 'process', { block_id = ctx.block_id })) end

local function foreground_cwd(ctx)
    local foreground = process(ctx).foreground
    return foreground and foreground.cwd
end

local function session_with_label(label)
    for _, session in ipairs(must(rex.call 'session.list').sessions) do
        if session.label == label then return session.session_id end
    end
end

local history_file = (os.getenv 'XDG_STATE_HOME' or home .. '/.local/state') .. '/rex/session-history'

local function session_history()
    local ids = {}
    local file = io.open(history_file)
    if not file then return ids end
    for id in file:lines() do
        ids[#ids + 1] = id
    end
    file:close()
    return ids
end

local function live_sessions()
    local live = {}
    for _, session in ipairs(must(rex.call 'session.list').sessions) do
        live[session.session_id] = true
    end
    return live
end

local function select_session(session_id, from)
    local live = live_sessions()
    local visits = { session_id }
    if from ~= session_id and live[from] then visits[2] = from end
    for _, id in ipairs(session_history()) do
        if #visits == 50 then break end
        if id ~= session_id and id ~= from and live[id] then visits[#visits + 1] = id end
    end
    exec_stdout { 'mkdir', '-p', history_file:match '(.*)/' }
    local file = must(io.open(history_file, 'w'))
    file:write(table.concat(visits, '\n'), '\n')
    file:close()
    rex.client.queue('session.select', { session_id = session_id })
    return { session_id = session_id }
end

local function open_session(dir, from)
    rex.exec { zoxide, 'add', dir }
    local label = tilde_path(dir)
    local session_id = session_with_label(label)
    if not session_id then
        session_id = must(rex.call('session.create', {
            label = label,
            initial_windows = { { layout = shell_block { cwd = dir, command = { '/bin/zsh', '-ic', 'p' } } } },
        })).session_id
        must(rex.call('session.attach', { session_id = session_id }))
    end
    return select_session(session_id, from)
end

local function ssh_hostname(alias)
    local resolved = rex.exec { 'ssh', '-G', alias }
    return resolved and resolved.ok and ('\n' .. resolved.stdout):match '\nhostname (%S+)' or alias
end

local function remote_web_url(remote)
    local url = remote:gsub('%s+$', ''):gsub('%.git$', '')
    local host, path = url:match '^[^/:]+@([^/:]+):(.+)$'
    if host then return 'https://' .. ssh_hostname(host) .. '/' .. path end
    local scheme, authority
    scheme, authority, path = url:match '^(%a[%w+.-]*)://([^/]+)/(.+)$'
    if not authority then return url end
    host = authority:gsub('^.*@', ''):gsub(':%d+$', '')
    if scheme:find 'ssh' then host = ssh_hostname(host) end
    return 'https://' .. host .. '/' .. path
end

local function open_zoomed(ctx, command)
    -- A floating layer leaves cells with the default background transparent, so zoom a split instead.
    local split = must(rex.session.new_split {
        anchor_id = ctx.block_id,
        direction = 'horizontal',
        side = 'after',
        focus = true,
        layout = shell_block { cwd = foreground_cwd(ctx), command = command },
    })
    must(rex.session.zoom_block { block_id = split.block_ids[1], zoom = true })
end

local function toggle_picker(label, command)
    for _, window in ipairs(must(rex.session.view {}).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                if layer.kind == 'floating' and block.label == label then
                    must(rex.session.close_layer { layer_id = layer.layer_id })
                    return
                end
            end
        end
    end
    must(rex.session.new_layer {
        bounds = { 0.225, 0.2, 0.55, 0.6 },
        focus = true,
        layout = shell_block { label = label, command = command },
    })
end

rex.action {
    name = 'session_open',
    title = 'Open Directory as Session',
    args = { dir = 'string', from = 'string?' },
    run = function(ctx, args) return open_session(args.dir, args.from or ctx.session_id) end,
}

rex.action {
    name = 'session_switch',
    title = 'Switch Session',
    args = { session_id = 'string', block_id = 'string?', from = 'string?' },
    run = function(ctx, args)
        if args.block_id then must(rex.call('session.focus_block', { session_id = args.session_id, block_id = args.block_id })) end
        return select_session(args.session_id, args.from or ctx.session_id)
    end,
}

rex.action {
    name = 'session_last',
    title = 'Switch to Previous Session',
    run = function(ctx)
        local live = live_sessions()
        for _, id in ipairs(session_history()) do
            if id ~= ctx.session_id and live[id] then return select_session(id, ctx.session_id) end
        end
    end,
}

rex.action {
    name = 'session_default',
    title = 'Name Only Session After Its Folder',
    args = { dir = 'string' },
    run = function(ctx, args)
        local sessions = must(rex.call 'session.list').sessions
        local blocks = must(rex.session.list_blocks {}).blocks
        if #sessions ~= 1 or sessions[1].session_id ~= ctx.session_id or #blocks ~= 1 then return end
        local label = tilde_path(args.dir)
        must(rex.session.set_label { label = label })
        return label
    end,
}

rex.action {
    name = 'session_picker',
    title = 'Pick Session',
    run = function(ctx)
        if not ctx.client_id then error('Pick Session runs from the Rex app', 0) end
        local request = rex.json.encode {
            client = ctx.client_id,
            session = ctx.session_id,
            rows_script = config_dir .. '/session-rows.lua',
            -- Rex starts from launchd with a bare PATH, so give the picker one that finds rex and zoxide.
            path = home
                .. '/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS:'
                .. shims
                .. ':/usr/bin:/bin',
        }
        local sent = must(rex.exec({ 'nc', '-U', home .. '/Library/Caches/rex-session-picker.sock' }, { stdin = request .. '\n', timeout = 2 }))
        if not sent.ok then error('Rex does not load the session picker. Run `just rex patch`, then reopen Rex.', 0) end
    end,
}

local listed = rex.exec { zoxide, 'query', '--list' }
-- The app runs a palette entry by name, so a name must keep its folder across config reloads.
local function action_name(dir)
    return 'open_dir_' .. dir:gsub('.', function(char) return ('%02x'):format(char:byte()) end)
end

if listed and listed.ok then
    for dir in listed.stdout:gmatch '[^\n]+' do
        rex.action {
            name = action_name(dir),
            title = tilde_path(dir),
            category = 'Directories',
            keywords = dir,
            run = function(ctx) return open_session(dir, ctx.session_id) end,
        }
    end
end

rex.action {
    name = 'lazygit',
    title = 'Open Lazygit',
    run = function(ctx)
        local bounds = { 0.05, 0.05, 0.9, 0.9 }
        local label = 'Lazygit'
        local lazygit
        for _, block in ipairs(must(rex.session.list_blocks {}).blocks) do
            if block.label == label then lazygit = block end
        end
        if not lazygit then
            must(rex.session.new_layer {
                bounds = bounds,
                focus = true,
                layout = shell_block { label = label, cwd = foreground_cwd(ctx), command = { 'lazygit' } },
            })
        elseif lazygit.block_id == ctx.block_id then
            must(rex.session.detach_block { block_id = lazygit.block_id })
        else
            if lazygit.placement ~= 'placed' then
                must(rex.session.move_block { block_id = lazygit.block_id, anchor_block_id = ctx.block_id })
                must(rex.session.float_block { block_id = lazygit.block_id, bounds = bounds })
            end
            must(rex.session.focus_block { block_id = lazygit.block_id })
        end
    end,
}

rex.action {
    name = 'runner',
    title = 'Toggle Floating Shell',
    run = function(ctx)
        local label = 'Run'
        for _, window in ipairs(must(rex.session.view {}).windows) do
            for _, layer in ipairs(window.layers) do
                for _, block in ipairs(layer.blocks) do
                    if block.label == label then
                        if block.block_id == ctx.block_id then
                            must(rex.session.set_layer_state { layer_id = layer.layer_id, state = 'minimized' })
                        elseif layer.kind == 'floating' then
                            must(rex.session.set_layer_state { layer_id = layer.layer_id, state = 'normal', focus = true })
                        else
                            must(rex.session.focus_block { block_id = block.block_id })
                        end
                        return
                    end
                end
            end
        end
        must(rex.session.new_layer {
            bounds = { 0.05, 0.05, 0.9, 0.9 },
            focus = true,
            layout = shell_block { label = label, cwd = foreground_cwd(ctx) },
        })
    end,
}

rex.action {
    name = 'sofka',
    title = 'Toggle Sofka',
    run = function(ctx)
        local label = 'Sofka'
        local bounds = { 0.05, 0.05, 0.9, 0.9 }
        local here, sofka, sofka_layer, sofka_window
        for _, window in ipairs(must(rex.session.view {}).windows) do
            for _, layer in ipairs(window.layers) do
                for _, block in ipairs(layer.blocks) do
                    if block.block_id == ctx.block_id then here = window.window_id end
                    if block.label == label then
                        sofka, sofka_layer, sofka_window = block, layer, window.window_id
                    end
                end
            end
        end
        if not sofka then
            must(rex.session.new_layer { bounds = bounds, focus = true, layout = shell_block { label = label, command = { 'sofka' } } })
        elseif sofka.block_id == ctx.block_id then
            local layer_id = sofka_layer.layer_id
            if sofka_layer.kind ~= 'floating' then layer_id = must(rex.session.float_block { block_id = sofka.block_id, bounds = bounds }).layer_id end
            must(rex.session.set_layer_state { layer_id = layer_id, state = 'minimized' })
        elseif sofka_window ~= here then
            must(rex.session.move_block { block_id = sofka.block_id, anchor_block_id = ctx.block_id })
            must(rex.session.float_block { block_id = sofka.block_id, bounds = bounds })
            must(rex.session.focus_block { block_id = sofka.block_id })
        elseif sofka_layer.kind == 'floating' then
            must(rex.session.set_layer_state { layer_id = sofka_layer.layer_id, state = 'normal', focus = true })
        else
            must(rex.session.focus_block { block_id = sofka.block_id })
        end
    end,
}

rex.action {
    name = 'nvim',
    title = 'Open Neovim',
    run = function(ctx) open_zoomed(ctx, { 'nvim', '-c', ('lua require("pi").open_last_edit(%q)'):format(ctx.block_id) }) end,
}

rex.action {
    name = 'browse_repo',
    title = 'Open Git Remote in Browser',
    run = function(ctx)
        local remote = exec_stdout({ 'git', 'ls-remote', '--get-url' }, { cwd = foreground_cwd(ctx) })
        rex.exec { 'open', remote_web_url(remote) }
    end,
}

rex.action {
    name = 'browse_pr',
    title = 'Open PR',
    keywords = 'pull request github browser branch',
    run = function(ctx)
        local result = must(rex.exec({ shims .. 'gh', 'pr', 'view', '--web' }, { cwd = foreground_cwd(ctx) }))
        if result.ok then return end
        local branch = result.stderr:match 'no pull requests found for branch "(.-)"'
        if branch then error('No PR for ' .. branch, 0) end
        if result.stderr:find 'not a git repository' then error('Not a git repository', 0) end
        error(result.stderr:match '[^\n]*', 0)
    end,
}

rex.action {
    name = 'copy_path',
    title = 'Copy Pane Directory',
    run = function(ctx)
        local pane = process(ctx)
        local launcher = pane.ancestors[1]
        local dir = launcher and launcher.cwd or pane.foreground.cwd
        must(rex.exec({ 'pbcopy' }, { stdin = dir }))
        -- Rex has no Lua call for an in-app notice, so send the pane an OSC 9 desktop notification.
        local tty = rex.exec { 'ps', '-o', 'tty=', '-p', tostring(pane.foreground.pid) }
        local tty_file = tty and tty.ok and io.open('/dev/' .. tty.stdout:gsub('%s', ''), 'w')
        if not tty_file then return end
        tty_file:write(('\27]9;Copied %s\7'):format(tilde_path(dir)))
        tty_file:close()
    end,
}

rex.action {
    name = 'open_url',
    title = 'Open URL from Pane',
    run = function(ctx)
        local size = must(rex.block.call(terminal, 'size', { block_id = ctx.block_id }))
        local screen = must(rex.block.call(terminal, 'format', { block_id = ctx.block_id, unwrap = true, trim = true }))
        local lines = {}
        for line in (screen.content .. '\n'):gmatch '(.-)\n' do
            lines[#lines + 1] = line
        end
        local visible = table.concat(lines, '\n', math.max(1, #lines - size.rows + 1))
        local urls = {}
        for url in exec_stdout({ config_dir .. '/url-picker', '--extract' }, { stdin = visible }):gmatch '[^\n]+' do
            urls[#urls + 1] = url
        end
        if #urls == 1 then
            rex.exec { 'open', urls[1] }
        elseif #urls > 1 then
            toggle_picker('Open URL', { config_dir .. '/url-picker', unpack(urls) })
        end
    end,
}

local function agent_working(block_id)
    local status = rex.block.call(terminal, 'program_status', { block_id = block_id })
    for _, record in ipairs(status and status.records or {}) do
        if record.state == 'working' then return true end
    end
    return false
end

rex.action {
    name = 'close_pane',
    title = 'Close Pane, Confirm Only While an Agent Works',
    run = function(ctx)
        if not ctx.block_id or agent_working(ctx.block_id) then
            rex.client.queue 'client.close'
        else
            must(rex.call('block.close', { session_id = ctx.session_id, block_id = ctx.block_id }))
        end
    end,
}

rex.bind('shift+cmd+k', 'client.palette.toggle')
rex.bind('ctrl+alt+shift+cmd+s', 'client.sidebar.toggle')
rex.bind('cmd+k', 'session_picker')

rex.bind('cmd+up', 'client.tab.previous')
rex.bind('cmd+down', 'client.tab.next')

rex.bind('ctrl+up', 'pane.focus.up')
rex.bind('ctrl+down', 'pane.focus.down')
rex.bind('ctrl+left', 'pane.focus.left')
rex.bind('ctrl+right', 'pane.focus.right')

rex.bind('shift+cmd+b', 'browse_repo')
rex.bind('cmd+l', 'lazygit')
rex.bind('cmd+r', 'runner')
rex.bind('cmd+s', 'sofka')
rex.bind('cmd+n', 'nvim')
rex.bind('cmd+u', 'open_url')
rex.bind('cmd+p', 'browse_pr')
rex.bind('cmd+y', 'copy_path')
rex.bind('cmd+w', 'close_pane')
