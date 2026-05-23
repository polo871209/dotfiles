vim.pack.add { 'https://github.com/mfussenegger/nvim-lint' }

local lint = require 'lint'
lint.linters_by_ft = {
    dockerfile = { 'hadolint' },
    python = { 'ruff' },
}

-- Global hadolint ignores (DL3007: latest tag)
lint.linters.hadolint.args = vim.list_extend(vim.deepcopy(lint.linters.hadolint.args or {}), { '--ignore', 'DL3007' })

-- Lint on these events
local lint_augroup = vim.api.nvim_create_augroup('lint', { clear = true })
vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWritePost', 'InsertLeave' }, {
    group = lint_augroup,
    callback = function()
        -- Only lint modifiable buffers
        if vim.bo.modifiable then lint.try_lint() end
    end,
})
