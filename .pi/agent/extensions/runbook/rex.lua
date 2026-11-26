local terminal = 'com.superlogical.terminal'
local args = rex.args
local pi_share = 0.6
local shells = { zsh = true, bash = true, fish = true, sh = true, dash = true, ksh = true, nu = true }

local function check(result, err)
    if err ~= nil then error(err, 0) end
    return result
end

local function view_blocks()
    local out = {}
    for _, window in ipairs(check(rex.session.view {}).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                out[#out + 1] = {
                    window_id = window.window_id,
                    floating = layer.kind == 'floating',
                    focused = window.focused_block_id == block.block_id,
                    block = block,
                }
            end
        end
    end
    return out
end

local function placement(block_id)
    for _, entry in ipairs(view_blocks()) do
        if entry.block.block_id == block_id then return entry end
    end
end

local function terminals()
    local out, own_window = {}, nil
    for _, entry in ipairs(view_blocks()) do
        local block = entry.block
        if block.block_id == args.self then
            own_window = entry.window_id
        elseif block.creator_name == terminal then
            out[#out + 1] = { block_id = block.block_id, label = block.label, window_id = entry.window_id }
        end
    end
    for _, t in ipairs(out) do
        t.sibling = t.window_id == own_window
    end
    return out
end

local function foreground(block_id)
    local result = rex.block.call(terminal, 'process', { block_id = block_id })
    return result and result.foreground
end

local function bracketed_paste(block_id)
    local result = rex.block.call(terminal, 'modes', { block_id = block_id })
    for _, mode in ipairs(result and result.modes or {}) do
        if mode.name == 'bracketed_paste' then return mode.set end
    end
    return false
end

local function describe(t)
    local fg = foreground(t.block_id)
    t.program = fg and fg.name
    t.cwd = fg and fg.cwd
    return t
end

local function split_beside()
    local split = check(rex.session.new_split {
        anchor_id = args.self,
        direction = 'horizontal',
        side = 'after',
        ratio = pi_share,
        layout = rex.layout.block { flavor = 'com.superlogical.terminal.shell', label = 'run', options = { cwd = args.cwd } },
    })
    local block_id = split.block_ids[1]
    for _ = 1, 30 do
        if bracketed_paste(block_id) then break end
        rex.sleep(0.1)
    end
    return block_id
end

local function resolve_target()
    if args.target == 'new' then return split_beside() end
    local all = terminals()
    for _, t in ipairs(all) do
        if t.block_id == args.target then return t.block_id end
    end
    local idle = {}
    for _, t in ipairs(all) do
        local fg = t.sibling and foreground(t.block_id)
        if fg and shells[fg.name or ''] then idle[#idle + 1] = t.block_id end
    end
    if #idle == 1 then return idle[1] end
    if #idle == 0 then return split_beside() end
end

local function targets()
    local out = {}
    for _, t in ipairs(terminals()) do
        out[#out + 1] = describe(t)
    end
    return { targets = out }
end

local function send()
    local block_id = resolve_target()
    if not block_id then return { status = 'pick' } end
    local fg = foreground(block_id)
    local program = fg and fg.name
    if not shells[program or ''] then return { status = 'busy', block_id = block_id, program = program } end
    local text = fg.cwd == args.cwd and args.text or args.text_in_folder
    if text:find('\n', 1, true) and not bracketed_paste(block_id) then return { status = 'no_bracketed_paste', block_id = block_id, program = program } end
    check(rex.call('block.event', {
        session_id = rex.session_id,
        block_id = block_id,
        event = { type = 'paste', payload = { text = text } },
    }))
    check(rex.session.focus_block { block_id = block_id })
    return { status = 'sent', block_id = block_id, program = program }
end

local function emit(event)
    io.stdout:write(rex.json.encode(event) .. '\n')
    io.stdout:flush()
end

local function watch()
    rex.on('terminal.process_changed', function(ctx, ev) emit { kind = 'process', block_id = ctx.block_id, program = ev.foreground and ev.foreground.name } end)
    rex.on('terminal.pwd_changed', function(ctx) emit { kind = 'pwd', block_id = ctx.block_id } end)
    rex.on('block_closed', function(_, ev) emit { kind = 'closed', block_id = ev.block_id } end)
end

local function tail(text, count)
    local lines = {}
    for line in (text .. '\n'):gmatch '(.-)\r?\n' do
        lines[#lines + 1] = line
    end
    while #lines > 0 and lines[#lines] == '' do
        lines[#lines] = nil
    end
    local out = {}
    for i = math.max(1, #lines - count + 1), #lines do
        out[#out + 1] = lines[i]
    end
    return out
end

local function screen(block_id, format)
    local result = rex.block.call(terminal, 'format', { block_id = block_id, format = format, trim = true, unwrap = format == 'text' })
    return result and result.content or ''
end

local function last_lines() return { lines = tail(screen(args.block_id, 'text'), args.count) } end

local function run()
    local id = check(rex.session.new_block {
        flavor = 'com.superlogical.terminal.shell',
        label = args.label,
        options = { cwd = args.cwd, shell = 'none', command = args.command, exit = { on_completion = false } },
    }).block_id
    rex.block.call(terminal, 'resize', { block_id = id, columns = args.columns, rows = args.rows })
    emit { kind = 'started', block_id = id }
    local previous
    local function snapshot()
        local content = screen(id, 'vt')
        if content == previous then return end
        previous = content
        emit { kind = 'screen', lines = tail(content, args.lines) }
    end
    local timer = rex.every(0.15, snapshot)
    -- A script cannot read its own stdin without blocking, so typed keys arrive through a FIFO that cat relays.
    -- An exec callback runs without the script's session, so the call names it.
    local session_id = rex.session_id
    rex.exec.start({ 'cat', args.input }, {
        stdout = function(keys)
            rex.call('block.method', { session_id = session_id, block_id = id, method = 'write', args = { data = keys } })
            rex.after(0.03, snapshot)
        end,
    })
    local function finish(closed)
        timer:cancel()
        if not closed then
            snapshot()
            emit { kind = 'exited', text = table.concat(tail(screen(id, 'text'), args.transcript), '\n') }
            local placed = placement(id)
            if placed and placed.floating and placed.focused then rex.session.focus_block { block_id = args.self } end
            if not placed or placed.floating then rex.call('block.close', { session_id = rex.session_id, block_id = id }) end
        else
            emit { kind = 'exited', text = '' }
        end
        rex.stop()
    end
    rex.on('terminal.child_exited', function(ctx)
        if ctx.block_id == id then finish(false) end
    end)
    rex.on('block_closed', function(_, ev)
        if ev.block_id == id then finish(true) end
    end)
    -- A block takes its owner's size, and this client asked for an inline-sized grid, so a placed block goes to the window's client.
    local disowned = false
    rex.on('session_view_changed', function()
        if disowned or not placement(id) then return end
        disowned = true
        rex.call('session.disown_block', { session_id = rex.session_id, block_ids = { id } })
    end)
end

local function rect_of(node, block_id)
    if type(node) ~= 'table' then return nil end
    if node.block_id == block_id then return node.rect end
    for _, child in pairs(node) do
        local rect = rect_of(child, block_id)
        if rect then return rect end
    end
end

local function float()
    local rect
    for _, window in ipairs(check(rex.session.view {}).windows) do
        for _, layer in ipairs(window.layers) do
            if layer.kind == 'tiled' then rect = rect or rect_of(layer.layout, args.self) end
        end
    end
    local x, y, w, h = unpack(rect or { 0, 0, 1, 1 })
    check(rex.session.move_block { block_id = args.block_id, anchor_block_id = args.self })
    check(rex.session.float_block { block_id = args.block_id, bounds = { x + w * 0.02, y + h * 0.4, w * 0.96, h * 0.58 } })
    check(rex.session.focus_block { block_id = args.block_id })
    return {}
end

local function place()
    check(rex.session.move_block { block_id = args.block_id, anchor_block_id = args.self, direction = 'horizontal', ratio = pi_share })
    check(rex.session.focus_block { block_id = args.block_id })
    return {}
end

local function close()
    check(rex.call('block.close', { session_id = rex.session_id, block_id = args.block_id }))
    return {}
end

local op = ({ targets = targets, send = send, watch = watch, run = run, float = float, place = place, last_lines = last_lines, close = close })[args.op]
    or error('unknown op: ' .. tostring(args.op), 0)
return op()
