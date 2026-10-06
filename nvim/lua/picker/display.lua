local M = {}

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

local PAD = ' '

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
