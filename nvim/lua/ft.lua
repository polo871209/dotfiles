-- Shared bodies for `after/ftplugin/`. That directory takes one file per
-- filetype, so related types (c/cpp, the prose types) would otherwise carry
-- byte-identical copies of the same settings.

local M = {}

--- Append to `b:undo_ftplugin`. Nvim only restores what that variable names, so
--- every setter has to register its own reset.
---@param cmds string
function M.undo(cmds) vim.b.undo_ftplugin = (vim.b.undo_ftplugin and vim.b.undo_ftplugin .. ' | ' or '') .. cmds end

--- Spell check on, for filetypes that are prose rather than code.
function M.prose()
    vim.opt_local.spell = true
    M.undo 'setl spell<'
end

---@class ft.IndentOpts
---@field width integer
---@field expandtab boolean? omit to leave 'expandtab' alone (gofmt keeps tabs)

---@param opts ft.IndentOpts
function M.indent(opts)
    vim.opt_local.tabstop = opts.width
    vim.opt_local.shiftwidth = opts.width
    if opts.expandtab == nil then
        M.undo 'setl ts< sw<'
        return
    end
    vim.opt_local.expandtab = opts.expandtab
    M.undo 'setl ts< sw< et<'
end

return M
