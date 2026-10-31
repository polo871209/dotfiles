-- Usage: rex do session-rows.lua current=SESSION_ID. Prints tab-separated picker rows: kind, target, block, display.
local terminal = 'com.superlogical.terminal'
local home = os.getenv 'HOME'
local current = rex.args.current
local marks = {
    working = '\27[33m●',
    blocked = '\27[31m◆',
    done = '\27[32m✓',
    error = '\27[31m✗',
    idle = '\27[2m○',
}

local function row(kind, target, block, display) io.stdout:write(kind, '\t', target, '\t', block, '\t', display, '\27[0m\n') end

local function tilde_path(dir)
    if dir == home or dir:sub(1, #home + 1) == home .. '/' then return '~' .. dir:sub(#home + 1) end
    return dir
end

local function agent_rows(session_id)
    for _, window in ipairs(assert(rex.call('session.view', { session_id = session_id })).windows) do
        for _, layer in ipairs(window.layers) do
            for _, block in ipairs(layer.blocks) do
                if block.creator_name == terminal then
                    local records = assert(rex.call(terminal .. '.program_status', { session_id = session_id, block_id = block.block_id, args = {} })).records
                        or {}
                    local root = records[1]
                    for _, record in ipairs(records) do
                        if not record.id then root = record end
                    end
                    if root then
                        local app = root.effective_app or root.app or '?'
                        row('agent', session_id, block.block_id, ('   %s %s\27[0m  %s'):format(marks[root.state] or root.state, app, root.msg or ''))
                    end
                end
            end
        end
    end
end

local open = {}
for _, session in ipairs(assert(rex.call('session.attach_all', { event_scope = 'session' })).sessions) do
    open[session.label] = true
    row('session', session.session_id, '-', session.label .. (session.session_id == current and ' \27[2m(current)' or ''))
    agent_rows(session.session_id)
end

local zoxide = assert(rex.exec { 'zoxide', 'query', '--list' })
for dir in zoxide.stdout:gmatch '[^\n]+' do
    local shown = tilde_path(dir)
    if not open[shown] then row('dir', dir, '-', '\27[2m' .. shown) end
end
