-- blink.cmp path source for zsh's edit-command-line buffer (b:shell_cmdline).
-- blink's own path source resolves against the buffer's directory, which is
-- zsh's temp file in /tmp here, and skips bare relative paths such as
-- `deploy/` because it reads them as URLs. This one completes the shell word
-- before the cursor against nvim's cwd, which is the shell's cwd.
local source = {}

function source.new() return setmetatable({}, { __index = source }) end

function source:get_trigger_characters() return { '/' } end

local MAX_ENTRIES = 2000

local WORD = '[^%s=\'"`<>|;&()]*$'

local function resolve_dir(dir_part)
    if dir_part == '' then return vim.fn.getcwd() end
    local dir = dir_part:gsub('^~/', vim.env.HOME .. '/')
    dir = dir:gsub('%$%{?([%w_]+)%}?', function(name) return vim.env[name] end)
    if dir:sub(1, 1) ~= '/' then dir = vim.fn.getcwd() .. '/' .. dir end
    return vim.fs.normalize(dir)
end

function source:get_completions(ctx, callback)
    local empty = { is_incomplete_forward = false, is_incomplete_backward = false, items = {} }
    local before = ctx.line:sub(1, ctx.cursor[2])
    local word = before:match(WORD)
    local dir_part, name = word:match '^(.*/)([^/]*)$'
    if not dir_part then
        dir_part, name = '', word
        local head = before:sub(1, #before - #word)
        if head:match '^%s*$' or head:match '[|;&(]%s*$' or name:sub(1, 1) == '-' then return callback(empty) end
    end

    local dir = resolve_dir(dir_part)
    local show_hidden = name:sub(1, 1) == '.'
    local kinds = require('blink.cmp.types').CompletionItemKind
    local row = ctx.cursor[1] - 1
    local range = {
        start = { line = row, character = #before - #name },
        ['end'] = { line = row, character = ctx.cursor[2] },
    }

    local items = {}
    for entry, type in vim.fs.dir(dir) do
        if show_hidden or entry:sub(1, 1) ~= '.' then
            if type == 'link' then type = (vim.uv.fs_stat(dir .. '/' .. entry) or {}).type end
            local is_dir = type == 'directory'
            local text = entry:gsub(' ', '\\ ')
            items[#items + 1] = {
                label = entry,
                kind = is_dir and kinds.Folder or kinds.File,
                filterText = entry,
                textEdit = { newText = text, range = range },
                sortText = (is_dir and '1' or '2') .. entry:lower(),
            }
            if #items >= MAX_ENTRIES then break end
        end
    end
    empty.items = items
    callback(empty)
end

return source
