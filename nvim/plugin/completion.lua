-- Agent nvim skips cosmetic plugins.
if vim.g.pi_agent then return end

-- vim.pack.add sources blink's own plugin/blink-cmp.lua, which merges blink's
-- extra completion capabilities into vim.lsp.config('*'); that has to land
-- before any client starts, so it cannot be deferred. Only setup() is lazy.
vim.pack.add {
    { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range '1.x' },
}

vim.api.nvim_create_autocmd('InsertEnter', {
    group = vim.api.nvim_create_augroup('blink-lazy', { clear = true }),
    once = true,
    callback = function()
        require('blink.cmp').setup {
            keymap = {
                preset = 'super-tab',
            },

            completion = {
                ghost_text = {
                    enabled = true,
                },
                list = {
                    max_items = 20,
                },
                trigger = {
                    show_on_insert_on_trigger_character = true,
                },
            },

            sources = {
                default = { 'path', 'buffer', 'lsp' },
                providers = {
                    path = {
                        score_offset = 100,
                        max_items = 5,
                        opts = {
                            trailing_slash = false,
                            label_trailing_slash = false,
                        },
                    },
                    buffer = {
                        score_offset = 75,
                        max_items = 5,
                        min_keyword_length = 3,
                    },
                    lsp = {
                        score_offset = 25,
                        max_items = 10,
                    },
                },
            },

            fuzzy = { implementation = 'prefer_rust_with_warning' },

            signature = { enabled = true },
        }
    end,
})
