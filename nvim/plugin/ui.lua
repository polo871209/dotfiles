-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

vim.pack.add {
    'https://github.com/folke/todo-comments.nvim',
    'https://github.com/folke/which-key.nvim',
    'https://github.com/stevearc/quicker.nvim',
}

require('todo-comments').setup { signs = false }

-- Spec entries default to mode 'n', so groups whose mappings are visual-only
-- or both must say so, or the popup labels a mode with nothing mapped in it.
require('which-key').setup {
    delay = 200,
    spec = {
        { '<leader><leader>', group = 'Ask pi', mode = 'x' },
        { '<leader>R', group = '[R]est (http)', mode = { 'n', 'x' } },
        { '<leader>g', group = '[G]it', mode = { 'n', 'x' } },
        { '<leader>p', group = 'vim [P]ack' },
        { '<leader>s', group = '[S]earch' },
        { '<leader>t', group = '[T]oggle' },
    },
}

-- 'cmdheight' is 0, so both native prompts draw where there is no room for
-- them. Selection reuses the picker widget rather than a second list float.
-- Required lazily: most sessions never prompt.
---@diagnostic disable-next-line: duplicate-set-field
vim.ui.input = function(opts, on_confirm) require('float').input(opts, on_confirm) end
---@diagnostic disable-next-line: duplicate-set-field
vim.ui.select = function(items, opts, on_choice) require('picker').select(items, opts, on_choice) end

require('quicker').setup {}

local render_markdown_loaded = false

vim.api.nvim_create_autocmd('FileType', {
    pattern = 'markdown',
    callback = function()
        if render_markdown_loaded then return end
        render_markdown_loaded = true
        vim.pack.add { 'https://github.com/MeanderingProgrammer/render-markdown.nvim' }
        -- Off by default: completes callout and checkbox markup via blink.
        require('render-markdown').setup {
            completions = { blink = { enabled = true } },
        }
    end,
})
