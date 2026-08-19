-- Boolean toggles with a one-line confirmation.

local M = {}

---@class ToggleSpec
---@field name string
---@field get fun(): boolean
---@field set fun(state: boolean)

---@param lhs string
---@param spec ToggleSpec
function M.map(lhs, spec)
    vim.keymap.set('n', lhs, function()
        local state = not spec.get()
        spec.set(state)
        vim.notify((state and 'Enabled ' or 'Disabled ') .. spec.name)
    end, { desc = 'Toggle ' .. spec.name })
end

--- Toggle a boolean vim option.
---@param lhs string
---@param opt string
---@param name string?
function M.option(lhs, opt, name)
    M.map(lhs, {
        name = name or opt,
        get = function() return vim.o[opt] end,
        set = function(state) vim.o[opt] = state end,
    })
end

return M
