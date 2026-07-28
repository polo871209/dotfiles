-- guess-indent runs in both lanes so agent edits match each file's existing
-- indent style (agent nvim has no other plugin that detects this).
vim.pack.add {
    'https://github.com/stevearc/conform.nvim',
    'https://github.com/NMAC427/guess-indent.nvim',
}
require('guess-indent').setup {}

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

-- Biome by default (its defaults already match Prettier's: double quotes,
-- semicolons, trailing commas, arrow parens; indent style/width conform
-- passes explicitly to match the buffer). Prettier only when a project opts
-- into it via config, or for Markdown/YAML which Biome doesn't format yet.
-- Prettier itself is not installed globally, so it only works inside
-- projects with a local node_modules/prettier.
local biome_configs = { 'biome.json', 'biome.jsonc' }
local prettier_configs = { '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml' }
local function biome_or_prettier(bufnr)
    local path = vim.api.nvim_buf_get_name(bufnr)
    if vim.fs.find(biome_configs, { upward = true, path = path })[1] then return { 'biome' } end
    if vim.fs.find(prettier_configs, { upward = true, path = path })[1] then return { 'prettier' } end
    return { 'biome' }
end

local format_on_save_enabled = true

-- Never format vendored/lock/skill content, regardless of filetype.
local ignore_patterns = { '/node_modules/', '/%.agents/skills/', '%.lock$' }
local function is_ignored(bufnr)
    local path = vim.api.nvim_buf_get_name(bufnr)
    for _, pattern in ipairs(ignore_patterns) do
        if path:match(pattern) then return true end
    end
    return false
end

require('conform').setup {
    notify_on_error = false,
    format_on_save = function(bufnr)
        if not format_on_save_enabled or is_ignored(bufnr) then return end
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
        markdown = { 'prettier' },
        ['markdown.mdx'] = { 'prettier' },
        mdx = { 'prettier' },
        protobuf = { 'buf' },
        python = { 'ruff_fix', 'ruff_format', 'ruff_organize_imports' },
        sql = { 'sqlfluff' },
        terraform = { 'terraform_fmt' },
        typescript = biome_or_prettier,
        typescriptreact = biome_or_prettier,
        yaml = { 'prettier' },
        ['yaml.docker-compose'] = { 'prettier' },
        ['yaml.github'] = { 'prettier' },
        ['yaml.gitlab'] = { 'prettier' },
        zig = { 'zigfmt' },
    },
    formatters = {
        ['clang-format'] = {
            prepend_args = { '--style={BasedOnStyle: Google, IndentWidth: 4, ReflowComments: false}' },
        },
        jsonnetfmt = {
            args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
        },
        sqlfluff = {
            require_cwd = false,
        },
    },
}

vim.keymap.set('', '<leader>f', function()
    if is_ignored(0) then return end
    require('conform').format { async = true, lsp_format = 'fallback' }
end, { desc = '[F]ormat buffer' })

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
