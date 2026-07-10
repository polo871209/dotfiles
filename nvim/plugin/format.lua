---@diagnostic disable: unused-local
---@diagnostic disable-next-line: unused-local
vim.pack.add { 'https://github.com/stevearc/conform.nvim' }

-- Lazy-load treesj behind its only keymap (~9ms off cold startup).
local treesj_loaded = false
vim.keymap.set('n', '<leader>m', function()
    if not treesj_loaded then
        treesj_loaded = true
        vim.pack.add { 'https://github.com/Wansmer/treesj' }
        require('treesj').setup { use_default_keymaps = false }
    end
    vim.cmd 'TSJToggle'
end, { desc = 'Toggle split/join' })

-- Use biome instead of prettier when biome config present in project
local function biome_or_prettier(bufnr)
    if vim.fs.find({ 'biome.json', 'biome.jsonc' }, { upward = true, path = vim.api.nvim_buf_get_name(bufnr) })[1] then return { 'biome' } end
    return { 'prettier' }
end

local format_on_save_enabled = true

require('conform').setup {
    notify_on_error = false,
    format_on_save = function(bufnr)
        if not format_on_save_enabled then return end
        return { timeout_ms = 1500, lsp_format = 'fallback' }
    end,
    formatters_by_ft = {
        bzl = { 'buildifier' },
        c = { 'clang-format' },
        cpp = { 'clang-format' },
        css = biome_or_prettier,
        cue = { 'cue_fmt' },
        go = { 'goimports' },
        html = biome_or_prettier,
        javascript = biome_or_prettier,
        javascriptreact = biome_or_prettier,
        json = biome_or_prettier,
        jsonnet = { 'jsonnetfmt' },
        lua = { 'stylua' },
        markdown = biome_or_prettier,
        protobuf = { 'buf' },
        python = { 'ruff_fix', 'ruff_format', 'ruff_organize_imports' },
        terraform = { 'terraform_fmt' },
        typescript = biome_or_prettier,
        typescriptreact = biome_or_prettier,
        yaml = biome_or_prettier,
        zig = { 'zigfmt' },
    },
    formatters = {
        ['clang-format'] = {
            prepend_args = { '--style={BasedOnStyle: Google, IndentWidth: 4, ReflowComments: false}' },
        },
        jsonnetfmt = {
            args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
        },
    },
}

vim.keymap.set('', '<leader>f', function() require('conform').format { async = true, lsp_format = 'fallback' } end, { desc = '[F]ormat buffer' })

-- Agent nvim skips snacks (see plugin/snacks.lua); an unguarded require here
-- errors inside the scheduled callback during --embed startup and wedges the
-- RPC channel — every agent lua call then hangs forever.
if not vim.g.pi_agent then
    vim.schedule(function()
        require('snacks').toggle
            .new({
                name = 'Format on Save',
                get = function() return format_on_save_enabled end,
                set = function(state) format_on_save_enabled = state end,
            })
            :map '<leader>tf'
    end)
end

