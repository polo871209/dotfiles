-- Self-contained fuzzy picker: fd/rg produce candidates, matchfuzzypos ranks
-- them, and picker/core.lua renders them. No plugin dependency beyond an
-- optional nvim-web-devicons for filetype icons.
--
-- This module holds only the sources; the widget lives in picker/core.lua.

local Picker = require 'picker.core'
local frecency = require 'picker.frecency'
local search = require 'picker.search'

local M = {}

---@param path string relative to `cwd`
---@param cwd string
---@param action string?
---@param lnum integer?
---@param col integer?
local function open_file(path, cwd, action, lnum, col)
    frecency.bump(path, cwd)
    -- Resolved against the picker's cwd, not nvim's: :tcd or an autocmd may have
    -- moved the latter while the picker was open.
    local abs = vim.fs.normalize(vim.fs.joinpath(cwd, path))
    vim.cmd "normal! m'" -- jumplist entry so <C-o> comes back
    vim.cmd(('%s %s'):format(action or 'edit', vim.fn.fnameescape(abs)))
    if lnum then pcall(vim.api.nvim_win_set_cursor, 0, { lnum, math.max(0, (col or 1) - 1) }) end
    vim.cmd 'normal! zz'
end

--- buffers + oldfiles + every file under cwd, ranked by frecency.
function M.smart()
    local list_cmd = search.files()
    if not list_cmd then
        vim.notify('picker: needs fd or rg on PATH', vim.log.levels.ERROR)
        return
    end
    Picker.new({
        title = 'Smart Files',
        kind = 'file',
        frecency = true,
        confirm = function(item, action, cwd) open_file(item.file, cwd, action) end,
        produce = function(self)
            local seen = {}
            local seed = {}
            local cur = vim.api.nvim_buf_get_name(0)

            local function push(path, bonus)
                if path == '' or seen[path] then return end
                local rel = vim.fs.relpath(self.cwd, path) or path
                if rel:sub(1, 1) == '/' then return end
                seen[path] = true
                seed[#seed + 1] = { text = rel, file = rel, bonus = bonus }
            end

            for _, buf in ipairs(vim.api.nvim_list_bufs()) do
                local name = vim.api.nvim_buf_get_name(buf)
                if vim.bo[buf].buflisted and name ~= '' and name ~= cur then push(name, 100) end
            end
            for _, path in ipairs(vim.v.oldfiles) do
                if vim.fn.filereadable(path) == 1 then push(path, 50) end
            end

            table.sort(seed, function(a, b) return (a.bonus + frecency.score(a.file, self.cwd)) > (b.bonus + frecency.score(b.file, self.cwd)) end)
            self:add(seed)

            self:spawn(list_cmd, function(line)
                local path = line:gsub('^%./', '')
                if seen[vim.fs.joinpath(self.cwd, path)] then return nil end
                return { text = path, file = path }
            end)
        end,
    }):open()
end

--- Live ripgrep. Every keystroke respawns rg; no client-side filtering.
---@param opts { hidden: boolean?, ignored: boolean? }?
function M.grep(opts)
    opts = opts or {}
    if not search.executable 'rg' then
        vim.notify('picker: needs rg on PATH', vim.log.levels.ERROR)
        return
    end
    Picker.new({
        title = 'Grep',
        kind = 'grep',
        live = true,
        confirm = function(item, action, cwd) open_file(item.file, cwd, action, item.lnum, item.col) end,
        produce = function(self, query)
            self:spawn(search.grep(query, opts), function(line)
                -- --null terminates the path with NUL: path\0lnum:col:text
                local file, rest = line:match '^([^%z]+)%z(.*)$'
                if not file then return nil end
                local lnum, col, text = rest:match '^(%d+):(%d+):(.*)$'
                if not lnum then return nil end
                return {
                    text = ('%s:%s:%s'):format(file, lnum, text),
                    file = file,
                    lnum = tonumber(lnum),
                    col = tonumber(col),
                    line = text,
                }
            end)
        end,
    }):open()
end

--- `vim.ui.select` on the picker widget, so the pane/choice prompts look and
--- behave like every other list here instead of a cmdline enumeration.
---@param items any[]
---@param opts { prompt: string?, format_item: (fun(item: any): string)?, kind: string? }?
---@param on_choice fun(item: any?, idx: integer?)
function M.select(items, opts, on_choice)
    opts = opts or {}
    local format = opts.format_item or tostring
    Picker.new({
        title = vim.trim((opts.prompt or 'Select'):gsub(':%s*$', '')),
        compact = #items,
        preview = false,
        confirm = function(item) on_choice(item.value, item.index) end,
        on_cancel = function() on_choice(nil, nil) end,
        produce = function(self)
            local list = {}
            for i, item in ipairs(items) do
                list[i] = { text = format(item), value = item, index = i }
            end
            self:add(list)
        end,
    }):open()
end

--- Spell suggestions for the word under the cursor.
function M.spelling()
    local word = vim.fn.expand '<cword>'
    if word == '' then return end
    local suggestions = vim.fn.spellsuggest(word)
    if #suggestions == 0 then
        vim.notify(('picker: no suggestions for %q'):format(word), vim.log.levels.INFO)
        return
    end
    local buf = vim.api.nvim_get_current_buf()
    local pos = vim.api.nvim_win_get_cursor(0)
    Picker.new({
        title = ('Spelling: %s'):format(word),
        preview = false,
        confirm = function(item)
            -- The picker restores the originating window, but the buffer in it
            -- can still have changed; replacing a word in the wrong one is worse
            -- than doing nothing.
            if vim.api.nvim_get_current_buf() ~= buf then return end
            vim.api.nvim_win_set_cursor(0, pos)
            vim.cmd(('normal! ciw%s'):format(item.text))
        end,
        produce = function(self)
            local items = {}
            for _, s in ipairs(suggestions) do
                items[#items + 1] = { text = s }
            end
            self:add(items)
        end,
    }):open()
end

return M
