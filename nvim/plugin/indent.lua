-- Indent guides. `listchars` `leadmultispace` only decorates literal leading
-- spaces, so it draws nothing on blank lines inside a block and nothing at all
-- in tab-indented buffers (go). Ephemeral extmarks anchored to a byte column
-- cover both and follow horizontal scroll for free.
if vim.g.pi_agent then return end

local ns = vim.api.nvim_create_namespace 'indent-guides'
local CHAR = '│'
local HL = 'Whitespace'

-- Shared by every guide; nvim copies the values out on each call.
local GUIDE = { virt_text = { { CHAR, HL } }, virt_text_pos = 'overlay', hl_mode = 'combine', priority = 1, ephemeral = true }

--- Byte offset of every guide column in a line's leading whitespace. Walks the
--- whitespace once so mixed tabs and spaces land on real screen columns.
---@param line string
---@param sw integer
---@param ts integer
---@return integer[]
local function guide_cols(line, sw, ts)
    local marks, cols, col, byte = {}, {}, 0, 0
    while true do
        local c = line:byte(byte + 1)
        if c == 32 then
            if col % sw == 0 then
                marks[#marks + 1] = byte
                cols[#cols + 1] = col
            end
            col, byte = col + 1, byte + 1
        elseif c == 9 then
            if col % sw == 0 then
                marks[#marks + 1] = byte
                cols[#cols + 1] = col
            end
            col, byte = col + ts - col % ts, byte + 1
        else
            break
        end
    end
    -- Trailing partial indent (a continuation line aligned to a paren) is not a
    -- level, so drop guides the whitespace is too short to hold.
    while #marks > 0 and cols[#cols] + sw > col do
        marks[#marks], cols[#cols] = nil, nil
    end
    return marks
end

-- Blank lines carry no whitespace to anchor to, so the whole run is one
-- overlay string starting at column 0.
local blanks = {} ---@type table<string, string>
local function blank_text(levels, sw)
    local key = levels .. ':' .. sw
    local text = blanks[key]
    if not text then
        text = string.rep(CHAR .. string.rep(' ', sw - 1), levels)
        blanks[key] = text
    end
    return text
end

--- Indent a blank line inherits: the shallower of its neighbours, plus one
--- level when they differ so the guide does not stop short at a block end.
---@param lnum integer
---@param sw integer
---@return integer
local function blank_indent(lnum, sw)
    local prev, next = vim.fn.prevnonblank(lnum), vim.fn.nextnonblank(lnum)
    if prev == 0 or next == 0 then return 0 end
    local a, b = vim.fn.indent(prev), vim.fn.indent(next)
    local indent = math.min(a, b)
    if a ~= b and indent > 0 then indent = indent + sw end
    return indent
end

vim.api.nvim_set_decoration_provider(ns, {
    on_win = function(_, win, buf, top, bot)
        -- Guides are whitespace decoration, so 'list' governs them as it did
        -- when they were a listchars entry: `:set nolist` hides them, and
        -- after/ftplugin/bigfile.lua switches them off with everything else.
        if vim.bo[buf].buftype ~= '' or not vim.wo[win].list then return false end
        local ts = vim.bo[buf].tabstop
        local sw = vim.bo[buf].shiftwidth
        if sw == 0 then sw = ts end
        if sw < 1 then return false end

        local lines = vim.api.nvim_buf_get_lines(buf, top, bot + 1, false)
        -- prevnonblank/indent read the current buffer.
        vim.api.nvim_buf_call(buf, function()
            for i, line in ipairs(lines) do
                local row = top + i - 1
                if line:find '^%s*$' then
                    local levels = math.floor(blank_indent(row + 1, sw) / sw)
                    if levels > 0 then
                        vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
                            virt_text = { { blank_text(levels, sw), HL } },
                            virt_text_pos = 'overlay',
                            hl_mode = 'combine',
                            priority = 1,
                            ephemeral = true,
                        })
                    end
                else
                    for _, col in ipairs(guide_cols(line, sw, ts)) do
                        vim.api.nvim_buf_set_extmark(buf, ns, row, col, GUIDE)
                    end
                end
            end
        end)
        return false
    end,
})
