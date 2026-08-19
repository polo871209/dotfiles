-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

vim.pack.add {
    { src = 'https://github.com/catppuccin/nvim', name = 'catppuccin' },
}

require('catppuccin').setup {
    transparent_background = true,

    -- Listed explicitly: auto_integrations calls vim.pack.get(), which shells
    -- out to git per plugin and costs ~200ms at startup.
    integrations = {
        blink_cmp = { enabled = true, style = 'bordered' },
        flash = true,
        gitsigns = true,
        mini = { enabled = true, indentscope_color = 'overlay2' },
        neotree = true,
        render_markdown = true,
        which_key = true,
    },

    -- Catppuccin italicises comments by default.
    styles = {
        comments = {},
    },

    custom_highlights = function()
        return {
            -- Gruvbox-style popup backgrounds
            NormalFloat = { bg = '#282828' },
            FloatBorder = { bg = '#282828', fg = '#fabd2f' },
        }
    end,
}

vim.cmd.colorscheme 'catppuccin-mocha'
