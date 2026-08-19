-- Highlights the other occurrences of whatever is selected, which is all of
-- visimatch.nvim we used. A decoration provider recomputes matches per redraw
-- over the visible lines only, so nothing has to be cleared when the selection
-- moves and nothing goes stale when the buffer changes.
if vim.g.pi_agent then return end

local ns = vim.api.nvim_create_namespace 'visual-match'
local HL = 'LspReferenceTarget'
-- Shorter selections match everywhere and just add noise.
local MIN_CHARS = 6
local MAX_LINES = 30
local IGNORECASE_FT = { help = true, markdown = true, text = true }

---@class VisualSelection
---@field lines string[] selected text, one entry per line
---@field buf integer
---@field ft string
---@field row integer 0-indexed start row, so the selection itself is skipped
---@field col integer 0-indexed start column
---@field ignorecase boolean

--- Current selection, or nil when there is nothing worth matching.
---@return VisualSelection?
local function selection()
    local mode = vim.fn.mode()
    -- Blockwise selections are not contiguous text.
    if mode ~= 'v' and mode ~= 'V' then return end

    local cursor = vim.api.nvim_win_get_cursor(0)
    local anchor = vim.fn.getpos 'v'
    local first, fcol = anchor[2], anchor[3] - 1
    local last, lcol = cursor[1], cursor[2]
    if first > last or (first == last and fcol > lcol) then
        first, fcol, last, lcol = last, lcol, first, fcol
    end
    if last - first + 1 > MAX_LINES then return end

    local buf = vim.api.nvim_get_current_buf()
    local lines = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
    if #lines == 0 then return end

    if mode == 'v' then
        -- Trim the tail first: on a single-line selection both edits apply to
        -- the same string, and fcol is an offset into the untrimmed line.
        -- 'selection' is inclusive, so the cursor's own character stays in.
        local tail = lines[#lines]
        lines[#lines] = tail:sub(1, lcol + vim.str_utf_end(tail, lcol + 1) + 1)
        lines[1] = lines[1]:sub(fcol + 1)
    else
        fcol = 0
    end

    local chars = 0
    for _, line in ipairs(lines) do
        chars = chars + #line
    end
    if chars < MIN_CHARS then return end
    -- Whitespace-only selections match every indent in the file.
    if #lines == 1 and lines[1]:find '^%s*$' then return end

    local ft = vim.bo[buf].filetype
    local ignorecase = IGNORECASE_FT[ft] or false
    if ignorecase then
        for i, line in ipairs(lines) do
            lines[i] = line:lower()
        end
    end

    return { lines = lines, buf = buf, ft = ft, row = first - 1, col = fcol, ignorecase = ignorecase }
end

local sel ---@type VisualSelection?

vim.api.nvim_set_decoration_provider(ns, {
    on_start = function()
        sel = selection()
        return sel ~= nil
    end,

    on_win = function(_, _, buf, top, bot)
        if not sel or vim.bo[buf].filetype ~= sel.ft then return false end

        local needle = sel.lines
        local n = #needle
        -- A match can start above the window or end below it; fetch the
        -- overhang so partially visible matches still highlight.
        local from = math.max(top - n + 1, 0)
        local lines = vim.api.nvim_buf_get_lines(buf, from, bot + n, false)
        if sel.ignorecase then
            for i, line in ipairs(lines) do
                lines[i] = line:lower()
            end
        end

        ---@param row integer 0-indexed
        ---@param scol integer
        ---@param ecol integer
        local function mark(row, scol, ecol)
            if row < top or row > bot then return end
            vim.api.nvim_buf_set_extmark(buf, ns, row, scol, { end_col = ecol, hl_group = HL, ephemeral = true })
        end

        --- The selection is already highlighted as Visual.
        ---@param row integer 0-indexed
        ---@param col integer 0-indexed
        ---@return boolean
        local function is_selection(row, col) return buf == sel.buf and row == sel.row and col == sel.col end

        if n == 1 then
            for i, line in ipairs(lines) do
                local row, init = from + i - 1, 1
                while true do
                    local s, e = line:find(needle[1], init, true)
                    if not s or not e then break end
                    if not is_selection(row, s - 1) then mark(row, s - 1, e) end
                    init = e + 1
                end
            end
            return false
        end

        -- Multi-line: the first line matches as a suffix, the interior lines
        -- whole, the last line as a prefix -- the shape a selection cuts out.
        local head, tail = needle[1], needle[n]
        for i = 1, #lines - n + 1 do
            local start = lines[i]
            local col = #start - #head
            local ok = col >= 0 and start:sub(col + 1) == head and lines[i + n - 1]:sub(1, #tail) == tail
            for j = 2, n - 1 do
                if not ok then break end
                ok = lines[i + j - 1] == needle[j]
            end
            if ok and not is_selection(from + i - 1, col) then
                mark(from + i - 1, col, #start)
                for j = 2, n - 1 do
                    mark(from + i + j - 2, 0, #needle[j])
                end
                mark(from + i + n - 2, 0, #tail)
            end
        end
        return false
    end,
})
