-- How one result row looks: highlight groups, filetype icons, treesitter marks
-- for grep lines, and the assembly of all three into a rendered string.

local M = {}

--- Highlight groups, all `default = true` so a colorscheme can override them.
function M.setup()
    local hl = {
        PickerMatch = { link = 'Special' },
        PickerDir = { link = 'Comment' },
        PickerFile = { link = 'Normal' },
        PickerDelim = { link = 'NonText' },
        PickerRow = { link = 'Number' },
        PickerCol = { link = 'NonText' },
        PickerSel = { link = 'Visual' },
        PickerPreviewLine = { link = 'CursorLine' },
    }
    for name, val in pairs(hl) do
        vim.api.nvim_set_hl(0, name, vim.tbl_extend('keep', val, { default = true }))
    end
end

local icons = nil
local icon_cache = {} ---@type table<string, [string, string]>

--- Filetype icon and its highlight for a path.
---
--- mini.icons resolves basenames and extensions directly and falls back to
--- nvim's own filetype detection for the rest (`.envrc`, `BUILD`), which
--- plugin/filetype.lua extends. The full path goes in so pattern-based
--- filetypes match. Results are memoised per basename because a render formats
--- every visible row.
---@param path string
---@return string, string
local function icon_for(path)
    if icons == nil then
        local ok, mod = pcall(require, 'mini.icons')
        icons = ok and mod or false
    end
    if not icons then return '', 'Normal' end

    local name = vim.fn.fnamemodify(path, ':t')
    local hit = icon_cache[name]
    if hit then return hit[1], hit[2] end

    local ic, hl = icons.get('file', path)
    ic, hl = ic or '', hl or 'Normal'
    icon_cache[name] = { ic, hl }
    return ic, hl
end

-- One reusable scratch buffer per language, so highlighting a list row costs a
-- parse rather than a buffer create.
local scratch = {} ---@type table<string, integer>

---@param lang string
---@return integer
local function scratch_buf(lang)
    local buf = scratch[lang]
    if not (buf and vim.api.nvim_buf_is_valid(buf)) then
        buf = vim.api.nvim_create_buf(false, true)
        scratch[lang] = buf
    end
    return buf
end

--- Treesitter highlights for a single line of code, as offsets into `text`.
--- This is what makes grep results read like source instead of flat strings.
---@param text string
---@param ft string?
---@return { col: integer, end_col: integer, hl: string }[]
local function ts_highlights(text, ft)
    if not ft or ft == '' or text == '' then return {} end
    local lang = vim.treesitter.language.get_lang(ft)
    if not lang then return {} end
    local buf = scratch_buf(lang)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { text })
    local parser = vim.treesitter.get_parser(buf, lang, { error = false })
    if not parser then return {} end

    local out = {}
    parser:parse(true)
    parser:for_each_tree(function(tstree, tree)
        if not tstree then return end
        local query = vim.treesitter.query.get(tree:lang(), 'highlights')
        if not query then return end
        for capture, node in query:iter_captures(tstree:root(), buf, 0, 1) do
            local name = query.captures[capture]
            if name ~= 'spell' then
                local sr, sc, er, ec = node:range()
                if sr == 0 then
                    out[#out + 1] = {
                        col = sc,
                        end_col = er > 0 and #text or ec,
                        hl = ('@%s.%s'):format(name, lang),
                    }
                end
            end
        end
    end)
    return out
end

--- Concatenate display segments into a line plus absolute highlight ranges.
--- Segments carry either a single hl for the whole chunk, or pre-computed
--- treesitter marks relative to the chunk.
---@param segments { [1]: string, [2]: string?, marks: table[]? }[]
---@return string, { col: integer, end_col: integer, hl: string }[]
local function join(segments)
    local parts, hls, off = {}, {}, 0
    for _, seg in ipairs(segments) do
        local text = seg[1]
        for _, m in ipairs(seg.marks or {}) do
            hls[#hls + 1] = { col = off + m.col, end_col = off + m.end_col, hl = m.hl }
        end
        if seg[2] then hls[#hls + 1] = { col = off, end_col = off + #text, hl = seg[2] } end
        parts[#parts + 1] = text
        off = off + #text
    end
    return table.concat(parts), hls
end

-- Left gutter, so rows do not sit flush against the window border.
local PAD = ' '

--- Path split into a dimmed directory and a bright basename. Returns the
--- segments plus the byte offset where `item.text` starts, so fuzzy match
--- positions map straight onto them.
---@param item PickerItem
---@return table[], integer
local function path_segments(item)
    local ic, ic_hl = icon_for(item.file or item.text)
    local segs = { { PAD }, { ic .. ' ', ic_hl } }
    local off = #PAD + #ic + 1
    local path = item.file or item.text
    local dir, base = path:match '^(.*/)([^/]+)$'
    if dir then
        segs[#segs + 1] = { dir, 'PickerDir' }
        segs[#segs + 1] = { base, 'PickerFile' }
    else
        segs[#segs + 1] = { path, 'PickerFile' }
    end
    return segs, off
end

--- Build one display row: its text, absolute highlight ranges, and the byte
--- offset at which `item.text` begins (nil when match positions cannot be
--- mapped onto it).
---@param item PickerItem
---@param kind ('file'|'grep')?
---@return string, { col: integer, end_col: integer, hl: string }[], integer?
function M.row(item, kind)
    if kind == 'file' then
        local segs, off = path_segments(item)
        local line, hls = join(segs)
        return line, hls, off
    elseif kind == 'grep' then
        local segs = path_segments(item)
        segs[#segs + 1] = { ':', 'PickerDelim' }
        segs[#segs + 1] = { tostring(item.lnum), 'PickerRow' }
        segs[#segs + 1] = { ':', 'PickerDelim' }
        segs[#segs + 1] = { tostring(item.col), 'PickerCol' }
        segs[#segs + 1] = { ' ' }
        -- Parsing is per-item and cached: a re-render on cursor movement must
        -- not re-run treesitter over every visible row.
        local text = (item.line or ''):gsub('^%s+', '')
        if item.marks == nil then
            item.ft = item.ft or vim.filetype.match { filename = item.file } or ''
            item.marks = ts_highlights(text, item.ft)
        end
        segs[#segs + 1] = { text, nil, marks = item.marks }
        local line, hls = join(segs)
        return line, hls, nil
    end
    return PAD .. item.text, {}, #PAD
end

return M
