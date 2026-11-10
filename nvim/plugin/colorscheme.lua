if vim.g.pi_agent then return end

vim.pack.add {
    { src = 'https://github.com/catppuccin/nvim', name = 'catppuccin' },
}

local rex_background = '#282828'

require('catppuccin').setup {
    transparent_background = true,

    -- Listed explicitly: auto_integrations calls vim.pack.get(), which shells
    -- out to git per plugin and costs ~200ms at startup.
    integrations = {
        blink_cmp = { enabled = true, style = 'bordered' },
        flash = true,
        mini = { enabled = true, indentscope_color = 'overlay2' },
        neotree = true,
        render_markdown = true,
        which_key = true,
    },

    styles = {
        comments = {},
    },

    custom_highlights = function()
        return {
            NormalFloat = { bg = rex_background },
            FloatBorder = { bg = rex_background, fg = '#fabd2f' },
        }
    end,
}

vim.cmd.colorscheme 'catppuccin-mocha'

if vim.g.opaque_background then
    vim.api.nvim_set_hl(0, 'Normal', vim.tbl_extend('force', vim.api.nvim_get_hl(0, { name = 'Normal' }), { bg = rex_background }))
end
