local terminal = 'com.superlogical.terminal'
local args = rex.args

local function check(result, err)
    if err ~= nil then error(err, 0) end
    return result
end

local function leaves(node, out)
    out = out or {}
    if node.block_id then
        out[#out + 1] = node.block_id
    else
        leaves(node.split.before, out)
        leaves(node.split.after, out)
    end
    return out
end

local function home_layer()
    for _, window in ipairs(check(rex.session.view {}).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                if block.block_id == rex.block_id then return layer end
            end
        end
    end
end

local function panel_of(layer)
    local labels = {}
    for _, block in ipairs(layer.blocks) do
        labels[block.block_id] = block.label
    end
    local panel = {}
    for _, block_id in ipairs(leaves(layer.layout)) do
        if (labels[block_id] or ''):match '^sub%-' then panel[#panel + 1] = block_id end
    end
    return panel
end

local function rows(node)
    if node.block_id then return 1 end
    local before, after = rows(node.split.before), rows(node.split.after)
    return node.split.direction == 'vertical' and before + after or math.max(before, after)
end

local function equalize(node)
    if node.block_id then return end
    local split = node.split
    if split.direction == 'vertical' then
        local before = rows(split.before)
        check(rex.session.resize_pane {
            direction = 'vertical',
            before_block_id = leaves(split.before)[1],
            after_block_id = leaves(split.after)[1],
            ratio = before / (before + rows(split.after)),
        })
    end
    equalize(split.before)
    equalize(split.after)
end

local function smallest_holding(node, members, count)
    if node.block_id then return node end
    for _, side in ipairs { node.split.before, node.split.after } do
        local held = 0
        for _, block_id in ipairs(leaves(side)) do
            if members[block_id] then held = held + 1 end
        end
        if held == count then return smallest_holding(side, members, count) end
    end
    return node
end

local function rebalance()
    local layer = home_layer()
    if not layer then return end
    local panel = panel_of(layer)
    if #panel < 2 then return end
    local members = {}
    for _, block_id in ipairs(panel) do
        members[block_id] = true
    end
    equalize(smallest_holding(layer.layout, members, #panel))
end

local function open()
    local layer = home_layer()
    local panel = layer and panel_of(layer) or {}
    local last = panel[#panel]
    local split = check(rex.session.new_split {
        anchor_id = last or rex.block_id,
        direction = last and 'vertical' or 'horizontal',
        side = 'after',
        ratio = not last and 0.75 or nil,
        layout = {
            block = {
                flavor = 'com.superlogical.terminal.shell',
                label = args.label,
                options = { cwd = args.cwd, command = args.command },
            },
        },
    })
    rebalance()
    return { block_id = split.block_ids[1] }
end

local function take_file(path)
    local file = io.open(path)
    if not file then return end
    local text = file:read '*a'
    file:close()
    os.remove(path)
    return text
end

local function screen()
    local result = rex.block.call(terminal, 'format', { block_id = args.block_id, trim = true, unwrap = true })
    return result and result.content
end

local function root_status()
    local result, err = rex.block.call(terminal, 'program_status', { block_id = args.block_id })
    if err ~= nil then return nil end
    for _, record in ipairs(result.records) do
        if record.id == nil or record.id == '' then return record end
    end
    return { state = 'starting' }
end

local function take_result()
    local text = take_file(args.result_file)
    return text and rex.json.decode(text)
end

local function watch()
    local deadline = os.time() + args.timeout
    while true do
        local record = root_status()
        if not record then
            local result = take_result()
            return { state = 'closed', output = result and result.output }
        end
        if record.state == 'blocked' then return { state = 'blocked', msg = record.msg, output = screen() } end
        local result = take_result()
        if result then
            if (result.output or '') == '' then result.output = screen() end
            return result
        end
        local remaining = deadline - os.time()
        if remaining <= 0 then return { state = 'timeout' } end
        rex.wait('block_event', function(ev) return ev.block_id == args.block_id end, math.min(remaining, 2))
    end
end

-- A paste event keeps newlines as text. Typed text would submit a partial message at the first newline.
local function steer()
    check(rex.call('block.event', {
        session_id = rex.session_id,
        block_id = args.block_id,
        event = { type = 'paste', payload = { text = args.text } },
    }))
    check(rex.block.call(terminal, 'write', { block_id = args.block_id, data = '\r' }))
end

local function close()
    for _, block_id in ipairs(args.block_ids) do
        rex.call('block.close', { session_id = rex.session_id, block_id = block_id })
    end
    for _, path in ipairs(args.files or {}) do
        os.remove(path)
    end
    rebalance()
end

local op = ({ open = open, watch = watch, steer = steer, close = close })[args.op] or error('unknown op: ' .. tostring(args.op), 0)
return op()
