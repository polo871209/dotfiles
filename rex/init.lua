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

local function open_session(dir)
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
    rex.client.queue('session.select', { session_id = session_id })
    return { session_id = session_id }
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

local function open_picker(label, command)
    must(rex.session.new_layer {
        bounds = { 0.225, 0.2, 0.55, 0.6 },
        focus = true,
        layout = shell_block { label = label, command = command },
    })
end

rex.action {
    name = 'session_open',
    title = 'Open Directory as Session',
    args = { dir = 'string' },
    run = function(_, args) return open_session(args.dir) end,
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
    run = function(ctx) open_picker('Pick Session', { config_dir .. '/session-picker', ctx.client_id }) end,
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
            run = function() return open_session(dir) end,
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
            open_picker('Open URL', { config_dir .. '/url-picker', unpack(urls) })
        end
    end,
}

rex.bind('shift+cmd+k', 'client.palette.toggle')
rex.bind('ctrl+alt+shift+cmd+s', 'client.sidebar.toggle')
rex.bind('ctrl+b>shift+k', 'session_picker')

rex.bind('cmd+up', 'client.tab.previous')
rex.bind('cmd+down', 'client.tab.next')

rex.bind('ctrl+up', 'pane.focus.up')
rex.bind('ctrl+down', 'pane.focus.down')
rex.bind('ctrl+left', 'pane.focus.left')
rex.bind('ctrl+right', 'pane.focus.right')
rex.bind('ctrl+b>ctrl+b', 'pane.send_key', { key = 'ctrl+b' })

rex.bind('shift+cmd+b', 'browse_repo')
rex.bind('cmd+l', 'lazygit')
rex.bind('shift+cmd+r', 'runner')
rex.bind('cmd+n', 'nvim')
rex.bind('cmd+u', 'open_url')
rex.bind('cmd+p', 'browse_pr')
rex.bind('cmd+y', 'copy_path')
