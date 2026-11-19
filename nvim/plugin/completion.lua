if vim.g.pi_agent then return end

-- vim.pack.add sources blink's own plugin/blink-cmp.lua, which merges blink's
-- extra completion capabilities into vim.lsp.config('*'); that has to land
-- before any client starts, so it cannot be deferred. Only setup() is lazy.
vim.pack.add {
    { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range '1.x' },
}

local lazy_group = vim.api.nvim_create_augroup('blink-lazy', { clear = true })
vim.api.nvim_create_autocmd('InsertEnter', {
    group = lazy_group,
    callback = function()
        if vim.b.completion == false then return end
        vim.api.nvim_del_augroup_by_id(lazy_group)
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
            },

            sources = {
                default = function()
                    if vim.b.shell_cmdline == 1 then return { 'shell_path', 'buffer', 'lsp' } end
                    return { 'path', 'buffer', 'lsp' }
                end,
                providers = {
                    path = {
                        score_offset = 100,
                        max_items = 5,
                        opts = {
                            trailing_slash = false,
                            label_trailing_slash = false,
                        },
                    },
                    shell_path = {
                        name = 'Path',
                        module = 'shell_path',
                        score_offset = 100,
                        max_items = 5,
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

            signature = { enabled = true },
        }
    end,
})
