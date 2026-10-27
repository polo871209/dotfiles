local terminal = 'com.superlogical.terminal'
local shell = terminal .. '.shell'
local home = os.getenv 'HOME'
-- The Rex server's PATH has no mise shims.
local shims = home .. '/.local/share/mise/shims/'
local zoxide = shims .. 'zoxide'
local config_dir = (os.getenv 'XDG_CONFIG_HOME' or home .. '/.config') .. '/rex'
local picker_bounds = { 0.225, 0.2, 0.55, 0.6 }

local function tilde_path(dir)
    local path = dir:gsub('(.)/+$', '%1')
    if path == home or path:sub(1, #home + 1) == home .. '/' then return '~' .. path:sub(#home + 1) end
    return path
end

local function session_with_label(label)
    local list, err = rex.call 'session.list'
    if err ~= nil then error(err, 0) end
    for _, session in ipairs(list.sessions) do
        if session.label == label then return session.session_id end
    end
end

local function open_session(dir)
    rex.exec { zoxide, 'add', dir }
    local label = tilde_path(dir)
    local session_id = session_with_label(label)
    if not session_id then
        local created, err = rex.call('session.create', {
            label = label,
            initial_windows = {
                { layout = rex.layout.block { flavor = shell, options = { cwd = dir, command = { '/bin/zsh', '-ic', 'p' } } } },
            },
        })
        if err ~= nil then error(err, 0) end
        session_id = created.session_id
        local _, attach_err = rex.call('session.attach', { session_id = session_id })
        if attach_err ~= nil then error(attach_err, 0) end
    end
    rex.client.queue('session.select', { session_id = session_id })
    return { session_id = session_id }
end

local function foreground_cwd(ctx)
    local process, err = rex.block.call(terminal, 'process', { block_id = ctx.block_id })
    if err ~= nil then error(err, 0) end
    return process.foreground and process.foreground.cwd
end

local function remote_web_url(remote)
    local url = remote:gsub('%s+$', ''):gsub('%.git$', '')
    local host, path = url:match '^[^/:]+@([^/:]+):(.+)$'
    if host then return 'https://' .. host .. '/' .. path end
    local authority
    authority, path = url:match '^%a[%w+.-]*://([^/]+)/(.+)$'
    if not authority then return url end
    return 'https://' .. authority:gsub('^.*@', ''):gsub(':%d+$', '') .. '/' .. path
end

local function open_zoomed(ctx, command)
    -- A floating layer leaves cells with the default background transparent, so zoom a split instead.
    local split, split_err = rex.session.new_split {
        anchor_id = ctx.block_id,
        direction = 'horizontal',
        side = 'after',
        focus = true,
        layout = rex.layout.block {
            flavor = shell,
            options = { cwd = foreground_cwd(ctx), command = command },
        },
    }
    if split_err ~= nil then error(split_err, 0) end
    local _, zoom_err = rex.session.zoom_block { block_id = split.block_ids[1], zoom = true }
    if zoom_err ~= nil then error(zoom_err, 0) end
end

-- Rex clips a floating layer at x = w and y = h instead of x + w and y + h, so the layer is stretched by its offset and fzf leaves the hidden part empty.
-- https://discord.com/channels/1546797889009881158/1560653603151282378
local function open_centered_fzf(label, command)
    local x, y, w, h = unpack(picker_bounds)
    local margin = ('0,%d%%,%d%%,0'):format(math.ceil(x / (x + w) * 100), math.ceil(y / (y + h) * 100))
    local _, err = rex.session.new_layer {
        bounds = { x, y, x + w, y + h },
        focus = true,
        layout = rex.layout.block {
            flavor = shell,
            label = label,
            options = { command = { 'env', 'FZF_DEFAULT_OPTS=--layout reverse --margin ' .. margin, unpack(command) } },
        },
    }
    if err ~= nil then error(err, 0) end
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
        local list, err = rex.call 'session.list'
        if err ~= nil then error(err, 0) end
        local blocks, blocks_err = rex.session.list_blocks {}
        if blocks_err ~= nil then error(blocks_err, 0) end
        local only = list.sessions[1]
        if #list.sessions ~= 1 or only.session_id ~= ctx.session_id or #blocks.blocks ~= 1 then return end
        local label = tilde_path(args.dir)
        local _, label_err = rex.session.set_label { label = label }
        if label_err ~= nil then error(label_err, 0) end
        return label
    end,
}

rex.action {
    name = 'session_picker',
    title = 'Pick Session',
    run = function(ctx)
        local _, err = rex.session.new_layer {
            bounds = picker_bounds,
            focus = true,
            layout = rex.layout.block {
                flavor = shell,
                options = { command = { config_dir .. '/session-picker', ctx.client_id } },
            },
        }
        if err ~= nil then error(err, 0) end
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
            run = function() return open_session(dir) end,
        }
    end
end

rex.action {
    name = 'lazygit',
    title = 'Open Lazygit',
    run = function(ctx) open_zoomed(ctx, { 'lazygit' }) end,
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
        local remote, err = rex.exec({ 'git', 'ls-remote', '--get-url' }, { cwd = foreground_cwd(ctx) })
        if not remote then error(err, 0) end
        if not remote.ok then error(remote.stderr, 0) end
        rex.exec { 'open', remote_web_url(remote.stdout) }
    end,
}

rex.action {
    name = 'browse_pr',
    title = 'Open PR',
    keywords = 'pull request github browser branch',
    run = function(ctx)
        local result, err = rex.exec({ shims .. 'gh', 'pr', 'view', '--web' }, { cwd = foreground_cwd(ctx) })
        if not result then error(err, 0) end
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
        local process, process_err = rex.block.call(terminal, 'process', { block_id = ctx.block_id })
        if process_err ~= nil then error(process_err, 0) end
        local dir = process.foreground.cwd
        local copied, copy_err = rex.exec({ 'pbcopy' }, { stdin = dir })
        if not copied then error(copy_err, 0) end
        -- Rex has no Lua call for an in-app notice, so send the pane an OSC 9 desktop notification.
        local tty = rex.exec { 'ps', '-o', 'tty=', '-p', tostring(process.foreground.pid) }
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
        local size, size_err = rex.block.call(terminal, 'size', { block_id = ctx.block_id })
        if size_err ~= nil then error(size_err, 0) end
        local screen, screen_err = rex.block.call(terminal, 'format', { block_id = ctx.block_id, unwrap = true, trim = true })
        if screen_err ~= nil then error(screen_err, 0) end
        local lines = {}
        for line in (screen.content .. '\n'):gmatch '(.-)\n' do
            lines[#lines + 1] = line
        end
        local visible = table.concat(lines, '\n', math.max(1, #lines - size.rows + 1))
        local found, exec_err = rex.exec({ config_dir .. '/url-picker', '--extract' }, { stdin = visible })
        if not found then error(exec_err, 0) end
        if not found.ok then error(found.stderr, 0) end
        local urls = {}
        for url in found.stdout:gmatch '[^\n]+' do
            urls[#urls + 1] = url
        end
        if #urls == 1 then
            rex.exec { 'open', urls[1] }
        elseif #urls > 1 then
            open_centered_fzf('Open URL', { config_dir .. '/url-picker', unpack(urls) })
        end
    end,
}

rex.bind('shift+cmd+k', 'client.palette.toggle')
rex.bind('ctrl+alt+shift+cmd+s', 'client.sidebar.toggle')
rex.bind('ctrl+b>shift+k', 'session_picker')

rex.bind('ctrl+up', 'client.tab.previous')
rex.bind('ctrl+down', 'client.tab.next')

rex.bind('ctrl+left', 'pane.focus.left')
rex.bind('ctrl+right', 'pane.focus.right')
rex.bind('ctrl+b>ctrl+b', 'pane.send_key', { key = 'ctrl+b' })

rex.bind('shift+cmd+b', 'browse_repo')
rex.bind('cmd+l', 'lazygit')
rex.bind('cmd+n', 'nvim')
rex.bind('cmd+u', 'open_url')
rex.bind('cmd+p', 'browse_pr')
rex.bind('cmd+y', 'copy_path')
