local terminal = 'com.superlogical.terminal'
local home = os.getenv 'HOME'
local current = rex.args.current
local rows = {}

local function tilde_path(dir)
    if dir == home or dir:sub(1, #home + 1) == home .. '/' then return '~' .. dir:sub(#home + 1) end
    return dir
end

local function add_agents(session)
    for _, window in ipairs(assert(rex.call('session.view', { session_id = session.session_id })).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                if block.creator_name == terminal then
                    local records = assert(rex.call(terminal .. '.program_status', { session_id = session.session_id, block_id = block.block_id, args = {} })).records
                        or {}
                    local root = records[1]
                    for _, record in ipairs(records) do
                        if not record.id then root = record end
                    end
                    if root then
                        rows[#rows + 1] = {
                            kind = 'agent',
                            session_id = session.session_id,
                            block_id = block.block_id,
                            label = root.effective_app or root.app or '?',
                            detail = root.msg,
                            state = root.state,
                            context = session.label,
                        }
                    end
                end
            end
        end
    end
end

local open = {}
for _, session in ipairs(assert(rex.call('session.attach_all', { event_scope = 'session' })).sessions) do
    open[session.label] = true
    rows[#rows + 1] = { kind = 'session', session_id = session.session_id, label = session.label, current = session.session_id == current }
    add_agents(session)
end

local zoxide = assert(rex.exec { 'zoxide', 'query', '--list' })
for dir in zoxide.stdout:gmatch '[^\n]+' do
    local shown = tilde_path(dir)
    if not open[shown] then rows[#rows + 1] = { kind = 'dir', dir = dir, label = shown } end
end

return { rows = rows }
