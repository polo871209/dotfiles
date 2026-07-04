-- Send selections / diagnostics from neovim to a running pi instance.
--
-- Finds the pi agent(s) in the current herdr workspace via `herdr pane
-- list`/`tab list` and injects text with `herdr pane run` (herdr auto-wraps
-- it in bracketed paste for panes that have that mode on, so embedded
-- newlines land as one message instead of one Enter per line). Multiple pi
-- agents in the workspace -> vim.ui.select to pick one.
local M = {}

local TIMEOUT = 1000

---@param msg string
---@param level? integer
local function notify(msg, level)
    vim.schedule(function() vim.notify(msg, level or vim.log.levels.INFO) end)
end

--- Read selected text from the current buffer between marks `<` and `>`.
---@param buf integer
---@return string?, integer?, integer?
local function get_visual_selection(buf)
    local s = vim.api.nvim_buf_get_mark(buf, '<')
    local e = vim.api.nvim_buf_get_mark(buf, '>')
    if s[1] == 0 and e[1] == 0 then return nil end
    local lines = vim.api.nvim_buf_get_lines(buf, s[1] - 1, e[1], false)
    return table.concat(lines, '\n'), s[1], e[1]
end

--- Build "<question>\n\n<filepath lines X-Y>\n<numbered snippet>" for a
--- selection. Sends only the selected lines, not the whole file, so the
--- message stays small and readable in pi's transcript; pi reads the file
--- itself if it needs more than the selection.
---@param input string
---@param selection string
---@param filepath string
---@param ft string
---@param sline integer?
---@param eline integer?
---@return string
local function build_selection_text(input, selection, filepath, ft, sline, eline)
    local snip_lines = vim.split(selection, '\n')
    local width = #tostring((eline or #snip_lines))
    local numbered = {}
    for i, l in ipairs(snip_lines) do
        numbered[i] = string.format('%' .. width .. 'd | %s', (sline or 1) + i - 1, l)
    end
    return string.format('%s\n\n%s lines %d-%d:\n```%s\n%s\n```', input, filepath, sline, eline, ft, table.concat(numbered, '\n'))
end

--- pi agent panes in the current herdr workspace.
---@return table[]  { pane_id, tab_id }
local function herdr_pi_panes()
    local r = vim.system({ 'herdr', 'pane', 'list' }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return {} end
    local ok, decoded = pcall(vim.json.decode, r.stdout)
    if not ok then return {} end
    local ws = vim.env.HERDR_WORKSPACE_ID
    local out = {}
    for _, p in ipairs((decoded.result or {}).panes or {}) do
        if p.workspace_id == ws and p.agent == 'pi' then table.insert(out, { pane_id = p.pane_id, tab_id = p.tab_id }) end
    end
    return out
end

--- tab_id -> display label, for labeling the picker.
---@return table<string, string>
local function herdr_tab_labels()
    local r = vim.system({ 'herdr', 'tab', 'list', '--workspace', vim.env.HERDR_WORKSPACE_ID }, { text = true, timeout = TIMEOUT }):wait()
    if r.code ~= 0 or not r.stdout then return {} end
    local ok, decoded = pcall(vim.json.decode, r.stdout)
    if not ok then return {} end
    local out = {}
    for _, t in ipairs((decoded.result or {}).tabs or {}) do
        out[t.tab_id] = t.label
    end
    return out
end

--- Resolve which herdr pane to send to: the workspace's only pi agent, or a
--- vim.ui.select prompt when there are several.
---@param cb fun(pane_id: string?)
local function resolve_herdr_pane(cb)
    if vim.env.HERDR_ENV ~= '1' then
        notify('pi integration requires herdr', vim.log.levels.ERROR)
        cb(nil)
        return
    end
    local panes = herdr_pi_panes()
    if #panes == 0 then
        notify('No pi agent found in this herdr workspace', vim.log.levels.ERROR)
        cb(nil)
        return
    end
    if #panes == 1 then
        cb(panes[1].pane_id)
        return
    end
    local labels = herdr_tab_labels()
    vim.ui.select(panes, {
        prompt = 'Send to which pi agent?',
        format_item = function(p) return labels[p.tab_id] or p.pane_id end,
    }, function(choice) cb(choice and choice.pane_id or nil) end)
end

--- Submit text + Enter into a herdr pane. herdr wraps it in bracketed paste
--- when the target pane has that mode on, so no manual wrapping here.
---@param pane_id string
---@param text string
local function send_herdr(pane_id, text)
    vim.system({ 'herdr', 'pane', 'run', pane_id, text }, { timeout = TIMEOUT }, function(result)
        if result.code ~= 0 then
            notify('Failed to send to pi: ' .. (result.stderr or 'unknown error'), vim.log.levels.ERROR)
        else
            notify 'Sent to pi'
        end
    end)
end

-- Public API --------------------------------------------------------------

function M.send_selection()
    vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<esc>', true, false, true), 'x', true)

    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then
        notify('Buffer has no file', vim.log.levels.WARN)
        return
    end

    local selection, sline, eline = get_visual_selection(buf)
    if not selection then
        notify('No visual selection', vim.log.levels.WARN)
        return
    end

    local filepath = vim.fn.fnamemodify(bufname, ':.')
    local ft = vim.bo[buf].filetype or ''

    resolve_herdr_pane(function(pane_id)
        if not pane_id then return end
        vim.ui.input({ prompt = 'pi: ' }, function(input)
            if not input or input == '' then return end
            send_herdr(pane_id, build_selection_text(input, selection, filepath, ft, sline, eline))
        end)
    end)
end

function M.send_diagnostics()
    local buf = vim.api.nvim_get_current_buf()
    local bufname = vim.api.nvim_buf_get_name(buf)
    if bufname == '' then
        notify('Buffer has no file', vim.log.levels.WARN)
        return
    end

    local diagnostics = vim.diagnostic.get(buf)
    if #diagnostics == 0 then
        notify('No diagnostics in current buffer', vim.log.levels.WARN)
        return
    end

    local severity_names = {
        [vim.diagnostic.severity.ERROR] = 'ERROR',
        [vim.diagnostic.severity.WARN] = 'WARNING',
        [vim.diagnostic.severity.INFO] = 'INFO',
        [vim.diagnostic.severity.HINT] = 'HINT',
    }
    local lines = {}
    for _, d in ipairs(diagnostics) do
        local severity = severity_names[d.severity] or 'UNKNOWN'
        table.insert(lines, string.format('[%s] Line %d: %s', severity, d.lnum + 1, (d.message or ''):gsub('\n', ' ')))
    end
    local filepath = vim.fn.fnamemodify(bufname, ':.')
    local text = 'Please review these diagnostics and help me fix them.\n\n' .. filepath .. ':\n' .. table.concat(lines, '\n')

    resolve_herdr_pane(function(pane_id)
        if pane_id then send_herdr(pane_id, text) end
    end)
end

return M
