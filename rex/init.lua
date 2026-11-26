local terminal = 'com.superlogical.terminal'
local home = os.getenv 'HOME'
-- The Rex server's PATH has no mise shims.
local shims = home .. '/.local/share/mise/shims/'
-- A mise shim call costs about 30 ms, so zoxide uses mise's global install link: https://mise.jdx.dev/ide-integration.html#global-version-link
local zoxide_dir = home .. '/.local/share/mise/installs/zoxide/global'
local zoxide = zoxide_dir .. '/zoxide'
local config_dir = (os.getenv 'XDG_CONFIG_HOME' or home .. '/.config') .. '/rex'
local rex_bin_dir = home .. '/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS'

local function must(result, err)
    if err ~= nil then error(err, 0) end
    return result
end

-- Rex keeps a failure notice on screen until dismissed, and the configuration file has no rex.after.
local function action(spec)
    local run = spec.run
    spec.run = function(ctx, args)
        local result = { pcall(run, ctx, args) }
        if result[1] then return unpack(result, 2) end
        if ctx.client_id then
            rex.exec.start(
                { '/bin/sh', '-c', 'sleep 2 && exec "$0" -C "$1" do client.notice.dismiss', rex_bin_dir .. '/rex', ctx.client_id },
                { detach = true }
            )
        end
        error(result[2], 0)
    end
    rex.action(spec)
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

local function select_session(session_id, from, window_id)
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
    rex.client.queue('session.select', { session_id = session_id, window_id = window_id })
    return { session_id = session_id }
end

local function window_of(session_id, block_id)
    for _, window in ipairs(must(rex.call('session.view', { session_id = session_id })).windows or {}) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                if block.block_id == block_id then return window.window_id end
            end
        end
    end
end

local function exists(path)
    local file = io.open(path)
    if file then file:close() end
    return file ~= nil
end

-- A clone-set-up repo has only the bare repository outside its branch folders, so git tools there need the default branch's folder.
local function work_folder(dir)
    local path = dir:gsub('(.)/+$', '%1')
    while path ~= '' do
        local head = io.open(path .. '/.bare/refs/remotes/origin/HEAD')
        if head then
            local branch = (head:read() or ''):match '^ref: refs/remotes/origin/(.+)$'
            head:close()
            local folder = branch and path .. '/' .. branch
            return folder and exists(folder .. '/.git') and folder or dir
        end
        if exists(path .. '/.git/HEAD') or exists(path .. '/.git') then return dir end
        path = path:match '^(.*)/[^/]*$'
    end
    return dir
end

local function open_session(dir, from)
    rex.exec { zoxide, 'add', dir }
    local label = tilde_path(dir)
    local session_id = session_with_label(label)
    if not session_id then
        session_id = must(rex.call('session.create', {
            label = label,
            initial_windows = { { layout = shell_block { cwd = work_folder(dir), command = { '/bin/zsh', '-ic', 'p' } } } },
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

local function view_blocks()
    local found = {}
    for _, window in ipairs(must(rex.session.view {}).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                found[#found + 1] = { window_id = window.window_id, layer = layer, block = block }
            end
        end
    end
    return found
end

-- move_block splits the anchor's layer, so an anchor in a floating layer would put the block into that float.
local function float_into_window(block_id, window_id, bounds)
    for _, entry in ipairs(view_blocks()) do
        if entry.window_id == window_id and entry.layer.kind == 'tiled' then
            must(rex.session.move_block { block_id = block_id, anchor_block_id = entry.block.block_id })
            must(rex.session.float_block { block_id = block_id, bounds = bounds })
            return
        end
    end
    error('The window has no tiled pane to float beside', 0)
end

local block_id_suffix = '[^:]+$'

local function hide_panel(block, layer, window_id)
    if block.label == 'Lazygit' then
        -- A detached block has no window_id, so its label records the window that hid it.
        must(rex.session.set_block_label { block_id = block.block_id, label = 'Lazygit ' .. window_id })
        must(rex.session.detach_block { block_id = block.block_id })
    elseif block.label:match '^Neovim ' then
        must(rex.session.detach_block { block_id = block.block_id })
    elseif block.label == 'Sofka' or block.label == 'Run' then
        must(rex.session.set_layer_state { layer_id = layer.layer_id, state = 'minimized' })
    end
end

local function hide_other_panels(window_id, shown_block_id)
    for _, entry in ipairs(view_blocks()) do
        local layer, block = entry.layer, entry.block
        if entry.window_id == window_id and layer.kind == 'floating' and layer.state ~= 'minimized' and block.block_id ~= shown_block_id then
            hide_panel(block, layer, window_id)
        end
    end
end

-- https://www.superlogical.com/rex/docs/customize/resume-rules
rex.set('resume.trust.pi', { command = { 'pi', '--session', rex.match.under '~/.pi/agent/sessions' } })
rex.set('resume.trust.lazygit', { command = { 'lazygit' } })
rex.set('resume.trust.sofka', { command = { 'sofka' } })
rex.set('resume.trust.nvim', {
    command = { 'nvim' },
    flags = { ['--cmd'] = { 'keep', values = 1 }, ['-c'] = { 'keep', values = 1 } },
})

-- lazygit, sofka, and nvim do not report OSC 7577, so the panel reports for them with its own pid and then execs them.
-- https://www.superlogical.com/rex/docs/build/program-resume#a-wrapper-to-make-any-program-resume
local report_resume_then_exec = [[
if [ -n "$OSC7577_TOKEN" ]; then
  b64() { printf %s "$1" | base64 | tr -d '\n'; }
  argv=$(for a in "$@"; do b64 "$a"; echo; done | paste -sd, -)
  body="pid=$$:time=$(date +%s):argv=$argv:cwd=$(b64 "$(pwd)")"
  mac=$(printf '%s:%s' "$body" "$OSC7577_TOKEN" | shasum -a 256 | cut -c1-64)
  printf '\033]7577;%s:mac=%s\033\\' "$body" "$mac" > /dev/tty
  unset OSC7577_TOKEN
fi
exec "$@"
]]

local function new_panel(spec)
    must(rex.session.new_layer {
        window_id = spec.window_id,
        bounds = spec.bounds,
        focus = true,
        layout = shell_block {
            label = spec.label,
            cwd = spec.cwd,
            command = { '/bin/sh', '-c', report_resume_then_exec, 'sh', unpack(spec.command) },
        },
    })
end

-- Returns the panel's block_id when it shows a panel that already runs.
local function toggle_panel(ctx, spec)
    local here, panel, panel_layer, panel_window
    for _, entry in ipairs(view_blocks()) do
        if entry.block.block_id == ctx.block_id then here = entry.window_id end
        if entry.block.label == spec.label then
            panel, panel_layer, panel_window = entry.block, entry.layer, entry.window_id
        end
    end
    if not panel then
        hide_other_panels(here)
        new_panel(spec)
        return
    end
    if panel.block_id == ctx.block_id then
        local layer_id = panel_layer.layer_id
        if panel_layer.kind ~= 'floating' then layer_id = must(rex.session.float_block { block_id = panel.block_id, bounds = spec.bounds }).layer_id end
        must(rex.session.set_layer_state { layer_id = layer_id, state = 'minimized' })
        return
    end
    hide_other_panels(here, panel.block_id)
    if panel_window ~= here then
        float_into_window(panel.block_id, here, spec.bounds)
        must(rex.session.focus_block { block_id = panel.block_id })
    elseif panel_layer.kind == 'floating' then
        must(rex.session.set_layer_state { layer_id = panel_layer.layer_id, state = 'normal', focus = true })
    else
        must(rex.session.focus_block { block_id = panel.block_id })
    end
    return panel.block_id
end

-- Returns the panel's block_id when it shows a panel that already runs.
local function toggle_detached_panel(ctx, spec)
    local here, panel
    for _, block in ipairs(must(rex.session.list_blocks {}).blocks) do
        if block.block_id == ctx.block_id then here = block.window_id end
        if block.label == spec.label then panel = block end
    end
    if not panel then
        hide_other_panels(here)
        new_panel(spec)
    elseif panel.block_id == ctx.block_id then
        must(rex.session.detach_block { block_id = panel.block_id })
    else
        hide_other_panels(here, panel.block_id)
        if panel.placement ~= 'placed' or panel.window_id ~= here then float_into_window(panel.block_id, here, spec.bounds) end
        must(rex.session.focus_block { block_id = panel.block_id })
        return panel.block_id
    end
end

local function toggle_picker(label, command)
    for _, entry in ipairs(view_blocks()) do
        if entry.layer.kind == 'floating' and entry.block.label == label then
            must(rex.session.close_layer { layer_id = entry.layer.layer_id })
            return
        end
    end
    must(rex.session.new_layer {
        bounds = { 0.225, 0.2, 0.55, 0.6 },
        focus = true,
        layout = shell_block { label = label, command = command },
    })
end

action {
    name = 'session_open',
    title = 'Open Directory as Session',
    args = { dir = 'string', from = 'string?' },
    run = function(ctx, args) return open_session(args.dir, args.from or ctx.session_id) end,
}

action {
    name = 'session_switch',
    title = 'Switch Session',
    args = { session_id = 'string', block_id = 'string?', from = 'string?' },
    run = function(ctx, args)
        if not args.block_id then return select_session(args.session_id, args.from or ctx.session_id) end
        must(rex.call('session.focus_block', { session_id = args.session_id, block_id = args.block_id }))
        return select_session(args.session_id, args.from or ctx.session_id, window_of(args.session_id, args.block_id))
    end,
}

action {
    name = 'session_last',
    title = 'Switch to Previous Session',
    run = function(ctx)
        local live = live_sessions()
        for _, id in ipairs(session_history()) do
            if id ~= ctx.session_id and live[id] then return select_session(id, ctx.session_id) end
        end
    end,
}

action {
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

action {
    name = 'session_picker',
    title = 'Pick Session',
    run = function(ctx)
        if not ctx.client_id then error('Pick Session runs from the Rex app', 0) end
        local request = rex.json.encode {
            client = ctx.client_id,
            session = ctx.session_id,
            rows_script = config_dir .. '/session-rows.lua',
            -- Rex starts from launchd with a bare PATH, so give the picker one that finds rex and zoxide.
            path = rex_bin_dir .. ':' .. zoxide_dir .. ':' .. shims .. ':/usr/bin:/bin',
        }
        local sent = must(rex.exec({ 'nc', '-U', home .. '/Library/Caches/rex-session-picker.sock' }, { stdin = request .. '\n', timeout = 2 }))
        if not sent.ok then error('Rex does not load the session picker. Run `just rex`, then reopen Rex.', 0) end
    end,
}

local listed = rex.exec { zoxide, 'query', '--list' }
-- The app runs a palette entry by name, so a name must keep its folder across config reloads.
local function action_name(dir)
    return 'open_dir_' .. dir:gsub('.', function(char) return ('%02x'):format(char:byte()) end)
end

if listed and listed.ok then
    for dir in listed.stdout:gmatch '[^\n]+' do
        action {
            name = action_name(dir),
            title = tilde_path(dir),
            category = 'Directories',
            keywords = dir,
            run = function(ctx) return open_session(dir, ctx.session_id) end,
        }
    end
end

action {
    name = 'lazygit',
    title = 'Open Lazygit',
    run = function(ctx)
        local bounds = { 0.02, 0.02, 0.96, 0.96 }
        local label = 'Lazygit'
        local blocks = must(rex.session.list_blocks {}).blocks
        local windows, window_id = {}, nil
        for _, block in ipairs(blocks) do
            if block.window_id then windows[block.window_id] = true end
            if block.block_id == ctx.block_id then window_id = block.window_id end
        end
        if not window_id then error('Open Lazygit runs from a pane', 0) end
        local hidden_label = label .. ' ' .. window_id
        local lazygit
        for _, block in ipairs(blocks) do
            local hidden_in = block.placement ~= 'placed' and (block.label == label and '' or block.label:match '^Lazygit (window:%S+)$')
            if block.label == hidden_label or block.label == label and block.window_id == window_id then
                lazygit = block
            elseif hidden_in and not windows[hidden_in] then
                must(rex.call('block.close', { session_id = ctx.session_id, block_id = block.block_id }))
            end
        end
        if not lazygit then
            local cwd = work_folder(foreground_cwd(ctx))
            hide_other_panels(window_id)
            new_panel { window_id = window_id, bounds = bounds, label = label, cwd = cwd, command = { 'lazygit' } }
        elseif lazygit.block_id == ctx.block_id then
            hide_panel(lazygit, nil, window_id)
        else
            hide_other_panels(window_id, lazygit.block_id)
            if lazygit.placement ~= 'placed' then float_into_window(lazygit.block_id, window_id, bounds) end
            if lazygit.label ~= label then must(rex.session.set_block_label { block_id = lazygit.block_id, label = label }) end
            must(rex.session.focus_block { block_id = lazygit.block_id })
        end
    end,
}

action {
    name = 'runner',
    title = 'Toggle Floating Shell',
    run = function(ctx)
        local label = 'Run'
        local here, run
        for _, entry in ipairs(view_blocks()) do
            if entry.block.block_id == ctx.block_id then here = entry.window_id end
            if not run and entry.block.label == label then run = entry end
        end
        if not run then
            local cwd = foreground_cwd(ctx)
            hide_other_panels(here)
            must(rex.session.new_layer {
                bounds = { 0.05, 0.05, 0.9, 0.9 },
                focus = true,
                layout = shell_block { label = label, cwd = cwd },
            })
        elseif run.block.block_id == ctx.block_id then
            must(rex.session.set_layer_state { layer_id = run.layer.layer_id, state = 'minimized' })
        else
            hide_other_panels(run.window_id, run.block.block_id)
            if run.layer.kind == 'floating' then
                must(rex.session.set_layer_state { layer_id = run.layer.layer_id, state = 'normal', focus = true })
            else
                must(rex.session.focus_block { block_id = run.block.block_id })
            end
        end
    end,
}

action {
    name = 'sofka',
    title = 'Toggle Sofka',
    run = function(ctx) toggle_panel(ctx, { label = 'Sofka', bounds = { 0.02, 0.02, 0.96, 0.96 }, command = { 'sofka' } }) end,
}

-- Neovim reads an address with a colon as host:port, so the socket name drops the "block:" prefix.
local nvim_socket_prefix = home .. '/Library/Caches/rex-nvim-'

action {
    name = 'nvim',
    title = 'Toggle Neovim',
    run = function(ctx)
        local cwd = foreground_cwd(ctx)
        local label = 'Neovim ' .. tilde_path(cwd)
        local open_last_edit = ('lua require("pi").open_last_edit(%q)'):format(ctx.block_id)
        local shown = toggle_detached_panel(ctx, {
            label = label,
            bounds = { 0, 0, 1, 1 },
            cwd = cwd,
            command = {
                'nvim',
                -- Rex leaves the unpainted cells of a floating layer transparent, so Neovim must paint its background.
                '--cmd',
                'let g:opaque_background = v:true',
                '--cmd',
                ('lua vim.fn.serverstart(%q .. vim.env.REX_BLOCK:match %q .. ".sock")'):format(nvim_socket_prefix, block_id_suffix),
                '-c',
                open_last_edit,
            },
        })
        if shown then
            rex.exec {
                shims .. 'nvim',
                '--server',
                nvim_socket_prefix .. shown:match(block_id_suffix) .. '.sock',
                '--remote-send',
                '<Cmd>' .. open_last_edit .. '<CR>',
            }
        end
    end,
}

action {
    name = 'browse_repo',
    title = 'Open Git Remote in Browser',
    run = function(ctx)
        local remote = exec_stdout({ 'git', 'ls-remote', '--get-url' }, { cwd = foreground_cwd(ctx) })
        rex.exec { 'open', remote_web_url(remote) }
    end,
}

action {
    name = 'pending_prs',
    title = 'Show Pending PRs',
    keywords = 'pull request github review merge stray branch',
    run = function(ctx)
        if not ctx.client_id then error('Show Pending PRs runs from the Rex app', 0) end
        local request = rex.json.encode { path = shims .. ':/usr/bin:/bin' }
        local sent = must(rex.exec({ 'nc', '-U', home .. '/Library/Caches/rex-pending.sock' }, { stdin = request .. '\n', timeout = 2 }))
        if not sent.ok then error('Rex does not load the Pending PRs extension. Run `just rex`, then reopen Rex.', 0) end
    end,
}

action {
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

action {
    name = 'copy_path',
    title = 'Copy Pane Directory',
    run = function(ctx)
        local pane = process(ctx)
        local launcher = pane.ancestors[1]
        local dir = launcher and launcher.cwd or pane.foreground.cwd
        must(rex.exec({ 'pbcopy' }, { stdin = dir }))
        local request = rex.json.encode { text = 'Copied ' .. tilde_path(dir) }
        local sent = must(rex.exec({ 'nc', '-U', home .. '/Library/Caches/rex-toast.sock' }, { stdin = request .. '\n', timeout = 2 }))
        if not sent.ok then error('Copied, but Rex does not load the toast extension. Run `just rex`, then reopen Rex.', 0) end
    end,
}

action {
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

action {
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

action {
    name = 'tab_new_next',
    title = 'New Tab After Current',
    run = function(ctx)
        local here
        for _, block in ipairs(must(rex.session.list_blocks {}).blocks) do
            if block.block_id == ctx.block_id then here = block.window_id end
        end
        local windows = must(rex.session.view {}).windows
        local next_window
        for i, window in ipairs(windows) do
            if window.window_id == here then next_window = windows[i + 1] end
        end
        local created = must(rex.session.new_window { focus = false, layout = shell_block { cwd = foreground_cwd(ctx) } })
        if next_window then must(rex.session.move_window { window_id = created.window_id, before_window_id = next_window.window_id }) end
        -- The app ignores a queued session.select for a window it has not received yet, so select from a separate rex process.
        rex.exec.start(
            { rex_bin_dir .. '/rex', '-C', ctx.client_id, 'do', 'session.select', 'session_id=' .. ctx.session_id, 'window_id=' .. created.window_id },
            { detach = true }
        )
    end,
}

rex.bind('shift+cmd+k', 'client.palette.toggle')
rex.bind('ctrl+alt+shift+cmd+s', 'client.sidebar.toggle')
rex.bind('cmd+k', 'session_picker')

rex.bind('cmd+t', 'tab_new_next')
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
rex.bind('shift+cmd+s', 'pending_prs')
rex.bind('cmd+y', 'copy_path')
rex.bind('cmd+w', 'close_pane')
