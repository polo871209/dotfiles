-- The picker widget: three floats, a candidate pool, and the matching, render
-- and scroll loop over them. Sources in `picker/init.lua` drive it through
-- `PickerOpts`; nothing here knows where candidates come from.
--
-- Layout is a fullscreen split, with the prompt under the list:
--   +-------------------------+-------------+
--   | list                    | preview 45% |
--   +-------------------------+             |
--   | input (reverse = true)  |             |
--   +-------------------------+-------------+

local display = require 'picker.display'
local float = require 'float'
local frecency = require 'picker.frecency'

local ns = vim.api.nvim_create_namespace 'picker'

local RENDER_MS = 30
local LIVE_DEBOUNCE_MS = 80
local PREVIEW_MAX_LINES = 2000
-- Re-sorting by frecency copies the match array; skip it once the result set is
-- large enough that matchfuzzypos' own ordering is good enough anyway.
local RESORT_LIMIT = 5000
-- Cap results per keystroke. Most of the cost of a match is marshalling result
-- dicts back across the Vim boundary, so capping keeps huge trees responsive.
local MATCH_LIMIT = 10000
-- Stop a live source once this many results land, then kill the process: nobody
-- scrolls past a few hundred grep hits, and letting rg run to completion on a
-- big tree is pure latency.
local LIVE_LIMIT = 10000

--- Scratch buffers stay non-modifiable so stray keys can't corrupt them; every
--- write flips the flag for the duration of the update.
---@param buf integer
---@param lines string[]
local function set_lines(buf, lines)
    if not vim.api.nvim_buf_is_valid(buf) then return end
    vim.bo[buf].modifiable = true
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
end

---@class PickerItem
---@field text string matched against the query
---@field file string? path, relative to cwd
---@field lnum integer?
---@field col integer?
---@field line string? source line, for grep results
---@field bonus number? static rank boost applied before frecency
---@field ft string? cached filetype, for treesitter highlighting
---@field marks table[]? cached treesitter marks for `line`
---@field value any? payload carried through vim.ui.select
---@field index integer? position in the original vim.ui.select list

---@class PickerOpts
---@field title string
---@field produce fun(picker: Picker, query: string?)
---@field confirm fun(item: PickerItem, action: string?, cwd: string)
---@field on_cancel fun()? run when the picker closes without a choice
---@field compact integer? render as a centred box this many rows tall, with no
--- prompt and no fuzzy filtering, for a fixed list the user only navigates
---@field kind ('file'|'grep')? display format
---@field live boolean? re-run produce per keystroke instead of fuzzy filtering
---@field frecency boolean? blend frecency into the match score
---@field preview boolean? set false to drop the preview pane entirely

---@class Picker
---@field opts PickerOpts
---@field items PickerItem[]
---@field pool { text: string, idx: integer }[] handed to matchfuzzypos
---@field pool_cache { text: string, idx: integer }[]? survivors of the last query
---@field matched PickerItem[]
---@field positions integer[][]
---@field query string
---@field last_query string?
---@field chose boolean? an item was confirmed, so closing is not a cancel
---@field sel integer
---@field top integer first visible row, for virtual scrolling
---@field dirty boolean
---@field closed boolean
---@field truncated boolean?
---@field cwd string
---@field from_win integer
---@field tick integer? invalidates stdout from superseded jobs
---@field job vim.SystemObj?
---@field timer uv.uv_timer_t?
---@field live_timer uv.uv_timer_t?
---@field list_buf integer
---@field input_buf integer? absent in compact mode, which has no prompt
---@field key_buf integer buffer the mappings and autocmds hang off
---@field preview_buf integer?
---@field list_win integer
---@field input_win integer?
---@field preview_win integer?
---@field list_h integer
---@field preview_ft string?
local Picker = {}
Picker.__index = Picker

---@param opts PickerOpts
---@return Picker
function Picker.new(opts)
    local self = setmetatable({}, Picker) --[[@as Picker]]
    self.opts = opts
    self.query = ''
    self.dirty = false
    self.closed = false
    self.cwd = vim.uv.cwd() or vim.fn.getcwd()
    self.from_win = vim.api.nvim_get_current_win()
    self:reset()
    return self
end

--- Drop every candidate and matching artefact, and invalidate stdout still in
--- flight from the job that produced them.
function Picker:reset()
    self.tick = (self.tick or 0) + 1
    self.items, self.pool, self.matched, self.positions = {}, {}, {}, {}
    self.pool_cache, self.last_query = nil, nil
    self.sel, self.top = 1, 1
    self.truncated = false
end

--- Live windows, skipping the ones this layout has no use for.
---@return integer[]
function Picker:wins()
    local wins = { self.list_win }
    if self.input_win then wins[#wins + 1] = self.input_win end
    if self.preview_win then wins[#wins + 1] = self.preview_win end
    return wins
end

---@return integer[]
function Picker:bufs()
    local bufs = { self.list_buf }
    if self.input_buf then bufs[#bufs + 1] = self.input_buf end
    if self.preview_buf then bufs[#bufs + 1] = self.preview_buf end
    return bufs
end

-- Below this the three floats cannot be given a positive height.
local MIN_LINES = 8

---@param buf integer
---@param cfg table
---@return integer
local function open_float(buf, cfg)
    return vim.api.nvim_open_win(
        buf,
        false,
        vim.tbl_extend('force', {
            relative = 'editor',
            style = 'minimal',
            border = 'rounded',
            zindex = 50,
        }, cfg)
    )
end

--- Centred box the size of its content, sharing width and top row with the
--- input float so the two read as one window.
function Picker:layout_compact()
    local anchor = float.anchor()
    local room = vim.o.lines - vim.o.cmdheight - anchor.row - 2
    self.list_h = math.max(1, math.min(self.opts.compact or 1, room))
    self.list_buf = vim.api.nvim_create_buf(false, true)
    self.list_win = open_float(self.list_buf, {
        row = anchor.row,
        col = anchor.col,
        width = anchor.width,
        height = self.list_h,
        title = (' %s '):format(self.opts.title or 'Select'),
        title_pos = 'center',
    })
end

--- Fullscreen split: results above the prompt, preview alongside.
function Picker:layout_full()
    local W, H = vim.o.columns, vim.o.lines - vim.o.cmdheight
    local preview_w = self.opts.preview == false and 0 or math.floor(W * 0.45)
    local left_w = W - preview_w
    local input_h = 1
    -- Every float carries a rounded border, costing 2 rows/cols each.
    local list_h = H - (input_h + 2) - 2

    self.list_buf = vim.api.nvim_create_buf(false, true)
    self.input_buf = vim.api.nvim_create_buf(false, true)

    self.list_win = open_float(self.list_buf, {
        row = 0,
        col = 0,
        width = left_w - 2,
        height = list_h,
        title = ' Results ',
        title_pos = 'center',
    })
    self.input_win = open_float(self.input_buf, {
        row = list_h + 2,
        col = 0,
        width = left_w - 2,
        height = input_h,
        title = (' %s '):format(self.opts.title or 'Picker'),
        title_pos = 'center',
    })
    if preview_w > 0 then
        self.preview_buf = vim.api.nvim_create_buf(false, true)
        self.preview_win = open_float(self.preview_buf, {
            row = 0,
            col = left_w,
            width = preview_w - 2,
            height = H - 2,
            title = ' Preview ',
            title_pos = 'center',
        })
    end
    self.list_h = list_h

    vim.bo[self.input_buf].buftype = 'nofile'
    -- The prompt is a plain scratch buffer, so blink.cmp would otherwise offer
    -- completions and ghost text over the query, and mini.pairs would close
    -- brackets typed into it.
    vim.b[self.input_buf].completion = false
    vim.b[self.input_buf].minipairs_disable = true
end

---@return boolean ok # false when the terminal is too small to lay out
function Picker:layout()
    if vim.o.lines - vim.o.cmdheight < MIN_LINES or vim.o.columns < 20 then
        vim.notify('picker: window too small', vim.log.levels.WARN)
        return false
    end
    if self.opts.compact then
        self:layout_compact()
    else
        self:layout_full()
    end
    -- Compact mode has no prompt, so the list itself takes focus and the keys.
    self.key_buf = self.input_buf or self.list_buf

    for _, win in ipairs(self:wins()) do
        vim.wo[win].wrap = false
        vim.wo[win].cursorline = false
    end
    if self.preview_win then vim.wo[self.preview_win].number = true end
    -- Preview churns through buffers on every cursor move; keeping undo off
    -- stops that from accumulating history for content nobody edits.
    for _, buf in ipairs(self:bufs()) do
        if buf ~= self.input_buf then
            vim.bo[buf].undolevels = -1
            vim.bo[buf].modifiable = false
        end
    end
    return true
end

--- vim.ui.select promises its callback runs even when nothing is picked.
function Picker:cancelled()
    if not self.chose and self.opts.on_cancel then vim.schedule(self.opts.on_cancel) end
end

function Picker:open()
    display.setup()
    if not self:layout() then
        self.closed = true
        self:cancelled()
        return
    end

    vim.api.nvim_set_current_win(self.input_win or self.list_win)
    if self.input_win then vim.cmd 'startinsert' end

    local group = vim.api.nvim_create_augroup('picker_' .. self.key_buf, { clear = true })
    if self.input_buf then
        vim.api.nvim_create_autocmd({ 'TextChangedI', 'TextChanged' }, {
            group = group,
            buffer = self.input_buf,
            callback = function() self:on_query() end,
        })
    end
    vim.api.nvim_create_autocmd({ 'WinLeave', 'BufLeave' }, {
        group = group,
        buffer = self.key_buf,
        callback = function() self:close() end,
    })

    self:map()
    self:load()
    self:schedule_render()
end

function Picker:map()
    local modes = self.input_buf and { 'i', 'n' } or { 'n' }
    local function set(lhs, fn) vim.keymap.set(modes, lhs, fn, { buffer = self.key_buf, nowait = true }) end
    set('<Esc>', function() self:close() end)
    set('<C-c>', function() self:close() end)
    set('<CR>', function() self:choose 'edit' end)
    set('<C-n>', function() self:move(1) end)
    set('<C-p>', function() self:move(-1) end)
    set('<Down>', function() self:move(1) end)
    set('<Up>', function() self:move(-1) end)
    if self.opts.compact then
        set('q', function() self:close() end)
        set('j', function() self:move(1) end)
        set('k', function() self:move(-1) end)
        return
    end
    set('<C-v>', function() self:choose 'vsplit' end)
    set('<C-x>', function() self:choose 'split' end)
    set('<C-t>', function() self:choose 'tabedit' end)
    set('<C-q>', function() self:send_qflist() end)
    set('<C-f>', function() self:move(self.list_h) end)
    set('<C-b>', function() self:move(-self.list_h) end)
    set('<C-d>', function() self:scroll_preview(0.5) end)
    set('<C-u>', function() self:scroll_preview(-0.5) end)
end

function Picker:close()
    if self.closed then return end
    self.closed = true
    for _, field in ipairs { 'timer', 'live_timer' } do
        local timer = self[field]
        if timer then
            timer:stop()
            timer:close()
            self[field] = nil
        end
    end
    self:stop_job()
    pcall(vim.api.nvim_del_augroup_by_name, 'picker_' .. self.key_buf)
    vim.cmd 'stopinsert'
    for _, win in ipairs(self:wins()) do
        pcall(vim.api.nvim_win_close, win, true)
    end
    for _, buf in ipairs(self:bufs()) do
        pcall(vim.api.nvim_buf_delete, buf, { force = true })
    end
    if vim.api.nvim_win_is_valid(self.from_win) then vim.api.nvim_set_current_win(self.from_win) end
    self:cancelled()
end

function Picker:stop_job()
    if self.job then
        pcall(function() self.job:kill 'sigterm' end)
        self.job = nil
    end
end

--- Feed items from a command, streaming stdout so the list fills as it arrives.
function Picker:spawn(cmd, on_line)
    self:stop_job()
    local pending = ''
    local tick = self.tick
    self.job = vim.system(cmd, {
        cwd = self.cwd,
        stdout = function(err, data)
            if err or not data or self.closed or tick ~= self.tick then return end
            pending = pending .. data
            local lines = vim.split(pending, '\n')
            pending = table.remove(lines)
            local batch = {}
            for _, line in ipairs(lines) do
                if line ~= '' then
                    local item = on_line(line)
                    if item then batch[#batch + 1] = item end
                end
            end
            if #batch > 0 then
                vim.schedule(function()
                    if self.closed or tick ~= self.tick then return end
                    self:add(batch)
                end)
            end
        end,
    }, function()
        vim.schedule(function()
            if tick == self.tick then self.job = nil end
        end)
    end)
end

function Picker:add(batch)
    local limit = self.opts.live and LIVE_LIMIT or nil
    if limit and #self.items + #batch >= limit then
        for i = #batch, 1, -1 do
            if #self.items + i > limit then batch[i] = nil end
        end
        self.truncated = true
        self:stop_job()
    end
    for _, item in ipairs(batch) do
        self.items[#self.items + 1] = item
        if not self.opts.live then self.pool[#self.pool + 1] = { text = item.text, idx = #self.items } end
    end
    if self.opts.live then
        -- rg already filtered; running a fuzzy pass over its output would both
        -- re-filter results the user asked for and choke on NUL bytes.
        vim.list_extend(self.matched, batch)
    elseif self.query == '' then
        -- With no query the pool is the match set, so arrivals show immediately.
        self:refilter()
    else
        self:match_batch(batch)
    end
    self:schedule_render()
end

--- Match only newly arrived items against the live query, appending survivors.
function Picker:match_batch(batch)
    local first = #self.items - #batch + 1
    local slice = {}
    for i = first, #self.items do
        slice[#slice + 1] = { text = self.items[i].text, idx = i }
    end
    local res = vim.fn.matchfuzzypos(slice, self.query, { key = 'text' })
    for i, dict in ipairs(res[1]) do
        self.matched[#self.matched + 1] = self.items[dict.idx]
        self.positions[#self.positions + 1] = res[2][i]
        -- The cache is the pool for the next, longer query. Survivors that
        -- arrive after it was built have to join it or they drop out of the
        -- results for good on the next keystroke.
        if self.pool_cache then self.pool_cache[#self.pool_cache + 1] = dict end
    end
end

function Picker:load()
    if self.opts.live then
        self:reload_live()
        return
    end
    self:reset()
    self.opts.produce(self)
end

--- Live sources (grep) re-run the command on every keystroke; rg does the
--- filtering, so no client-side fuzzy pass happens at all.
function Picker:reload_live()
    self:reset()
    self:stop_job()
    if self.query ~= '' then self.opts.produce(self, self.query) end
    self:schedule_render()
end

function Picker:on_query()
    local line = vim.api.nvim_buf_get_lines(self.input_buf, 0, 1, false)[1] or ''
    if line == self.query then return end
    self.query = line
    if self.opts.live then
        local timer = self.live_timer or vim.uv.new_timer()
        if not timer then return end
        self.live_timer = timer
        timer:stop()
        timer:start(
            LIVE_DEBOUNCE_MS,
            0,
            vim.schedule_wrap(function()
                if not self.closed then self:reload_live() end
            end)
        )
        return
    end
    self:refilter()
    self:schedule_render()
end

--- Re-order matches by fuzzy score blended with frecency and the static bonus,
--- carrying the parallel `positions` array along.
---@param matched PickerItem[]
---@param positions integer[][]
---@param scores number[] per-match fuzzy scores from matchfuzzypos
---@return PickerItem[], integer[][]
function Picker:rerank(matched, positions, scores)
    local score = {}
    for i, item in ipairs(matched) do
        score[item] = (scores[i] or 0) + frecency.score(item.file or item.text, self.cwd) * 10 + (item.bonus or 0)
    end
    local order = {}
    for i = 1, #matched do
        order[i] = i
    end
    table.sort(order, function(a, b) return score[matched[a]] > score[matched[b]] end)
    local ranked, ranked_pos = {}, {}
    for i, o in ipairs(order) do
        ranked[i], ranked_pos[i] = matched[o], positions[o]
    end
    return ranked, ranked_pos
end

function Picker:refilter()
    local q = self.query
    if q == '' then
        -- A copy, not `self.items`: the live branch of `add` appends to
        -- `matched`, and aliasing the two would corrupt the item list.
        self.matched = vim.list_slice(self.items)
        self.positions = {}
        self.pool_cache = nil
        self.truncated = false
    else
        -- Growing the query can only shrink the match set, so re-match against
        -- the previous survivors instead of every item.
        local pool = self.pool
        local cache, prev = self.pool_cache, self.last_query
        if cache and prev and prev ~= '' and q:sub(1, #prev) == prev then pool = cache end
        local res = vim.fn.matchfuzzypos(pool, q, { key = 'text', limit = MATCH_LIMIT })
        -- A truncated result set is not a valid pool for the next keystroke: an
        -- item cut off here could outrank the survivors on a longer query.
        self.truncated = #res[1] >= MATCH_LIMIT
        self.pool_cache = not self.truncated and res[1] or nil
        local matched, positions = {}, {}
        for i, dict in ipairs(res[1]) do
            matched[i] = self.items[dict.idx]
            positions[i] = res[2][i]
        end
        if self.opts.frecency and #matched <= RESORT_LIMIT then
            matched, positions = self:rerank(matched, positions, res[3])
        end
        self.matched, self.positions = matched, positions
    end
    self.last_query = q
    self.sel = math.min(self.sel, math.max(#self.matched, 1))
    self.top = 1
end

function Picker:schedule_render()
    if self.dirty or self.closed then return end
    local timer = self.timer or vim.uv.new_timer()
    if not timer then return end
    self.dirty = true
    self.timer = timer
    timer:stop()
    timer:start(
        RENDER_MS,
        0,
        vim.schedule_wrap(function()
            self.dirty = false
            if not self.closed then self:render() end
        end)
    )
end

--- `delta` is in screen rows: positive always moves the selection visually
--- down, which walks *back* through the results in the bottom-up full layout
--- and forward in the top-down compact one.
---@param delta integer
function Picker:move(delta)
    if #self.matched == 0 then return end
    local step = self.opts.compact and delta or -delta
    self.sel = math.max(1, math.min(#self.matched, self.sel + step))
    self:schedule_render()
end

function Picker:render()
    if not vim.api.nvim_win_is_valid(self.list_win) then return end
    local total = #self.matched
    -- Keep the selection inside the viewport.
    if self.sel < self.top then self.top = self.sel end
    if self.sel > self.top + self.list_h - 1 then self.top = self.sel - self.list_h + 1 end
    self.top = math.max(1, self.top)

    -- The full layout puts the best match on the bottom row, next to the input,
    -- and grows upward, padding the top with blanks when results are few. The
    -- compact box has no prompt to sit beside, so it reads top-down and keeps
    -- the caller's order.
    local lines, meta = {}, {}
    for row = 1, self.list_h do
        lines[row] = ''
    end
    for i = self.top, math.min(#self.matched, self.top + self.list_h - 1) do
        local offset = i - self.top
        local row = self.opts.compact and offset + 1 or self.list_h - offset
        local line, hls, off = display.row(self.matched[i], self.opts.kind)
        lines[row] = line
        meta[row] = { hls = hls, off = off, idx = i }
    end

    set_lines(self.list_buf, lines)
    vim.api.nvim_buf_clear_namespace(self.list_buf, ns, 0, -1)

    for row, m in pairs(meta) do
        for _, hl in ipairs(m.hls) do
            pcall(vim.api.nvim_buf_set_extmark, self.list_buf, ns, row - 1, hl.col, {
                end_col = hl.end_col,
                hl_group = hl.hl,
                priority = 100,
            })
        end
        local positions = self.positions[m.idx]
        if positions and m.off then
            for _, pos in ipairs(positions) do
                -- matchfuzzypos yields 0-based char indices into item.text,
                -- which is laid out verbatim starting at `off`.
                local col = m.off + pos
                if col < #lines[row] then
                    pcall(vim.api.nvim_buf_set_extmark, self.list_buf, ns, row - 1, col, {
                        end_col = col + 1,
                        hl_group = 'PickerMatch',
                        priority = 200,
                    })
                end
            end
        end
        if m.idx == self.sel then
            vim.api.nvim_buf_set_extmark(self.list_buf, ns, row - 1, 0, {
                hl_group = 'PickerSel',
                hl_eol = true,
                end_row = row,
                priority = 50,
            })
        end
    end

    -- Compact mode shows the whole list at once, so a running count is noise;
    -- it keeps the caller's prompt as its title.
    if not self.opts.compact then
        vim.api.nvim_win_set_config(self.list_win, {
            title = (' Results  %d/%d%s '):format(math.min(self.sel, total), total, self.truncated and '+' or ''),
            title_pos = 'center',
        })
    end
    self:render_preview()
end

function Picker:render_preview()
    local item = self.matched[self.sel]
    if not self.preview_win or not vim.api.nvim_win_is_valid(self.preview_win) then return end
    if not item then
        set_lines(self.preview_buf, {})
        return
    end

    ---@type string[]?, string?, integer?
    local lines, ft, lnum
    if item.file then
        local path = vim.fs.normalize(vim.fs.joinpath(self.cwd, item.file))
        if vim.fn.filereadable(path) == 0 then path = item.file end
        local ok, read = pcall(vim.fn.readfile, path, '', PREVIEW_MAX_LINES)
        if not ok then
            set_lines(self.preview_buf, { '' })
            return
        end
        lines, lnum = read, item.lnum
        ft = vim.filetype.match { filename = path, contents = read }
    else
        lines = { item.text }
    end

    set_lines(self.preview_buf, lines)
    vim.api.nvim_buf_clear_namespace(self.preview_buf, ns, 0, -1)

    if ft and ft ~= self.preview_ft then
        self.preview_ft = ft
        pcall(vim.treesitter.stop, self.preview_buf)
        if not pcall(vim.treesitter.start, self.preview_buf, ft) then vim.bo[self.preview_buf].syntax = ft end
    end

    if lnum and lnum >= 1 and lnum <= #lines then
        vim.api.nvim_buf_set_extmark(self.preview_buf, ns, lnum - 1, 0, {
            hl_group = 'PickerPreviewLine',
            hl_eol = true,
            end_row = lnum,
        })
        pcall(vim.api.nvim_win_set_cursor, self.preview_win, { lnum, 0 })
        vim.api.nvim_win_call(self.preview_win, function() vim.cmd 'normal! zz' end)
    else
        pcall(vim.api.nvim_win_set_cursor, self.preview_win, { 1, 0 })
    end
end

function Picker:scroll_preview(frac)
    if not self.preview_win or not vim.api.nvim_win_is_valid(self.preview_win) then return end
    local delta = math.floor(vim.api.nvim_win_get_height(self.preview_win) * frac)
    vim.api.nvim_win_call(self.preview_win, function()
        local target = vim.fn.line '.' + delta
        target = math.max(1, math.min(vim.fn.line '$', target))
        vim.api.nvim_win_set_cursor(self.preview_win, { target, 0 })
        vim.cmd 'normal! zz'
    end)
end

function Picker:choose(action)
    local item = self.matched[self.sel]
    if not item then return end
    local cwd = self.cwd
    self.chose = true
    self:close()
    vim.schedule(function() self.opts.confirm(item, action, cwd) end)
end

function Picker:send_qflist()
    local list = {}
    for _, item in ipairs(self.matched) do
        if item.file then
            list[#list + 1] = {
                filename = vim.fs.normalize(vim.fs.joinpath(self.cwd, item.file)),
                lnum = item.lnum or 1,
                col = item.col or 1,
                text = item.line or item.text,
            }
        end
    end
    if #list == 0 then return end
    self:close()
    vim.schedule(function()
        vim.fn.setqflist(list, 'r')
        vim.cmd 'copen'
    end)
end

return Picker
