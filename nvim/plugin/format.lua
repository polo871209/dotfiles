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
    if not pcall(vim.treesitter.get_parser, 0) then
        vim.notify('TreeSJ: no treesitter parser for this buffer', vim.log.levels.WARN)
        return
    end
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
local biome_configs = { 'biome.json', 'biome.jsonc', '.biome.json', '.biome.jsonc' }
-- Keep in sync with the set conform's own prettier formatter roots on (see
-- conform/formatters/prettierd.lua); a spelling missing here silently falls
-- through to Biome.
local prettier_configs = {
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.json5',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
}
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

-- sqlfluff shells out to a separate process per lint/format and is
-- noticeably slower than the other formatters here, so it runs
-- post-write (format_after_save) instead of blocking the sync save path.
local SLOW_FORMATTERS_BY_FT = { sql = true }

require('conform').setup {
    notify_on_error = false,
    -- Applied to every format call, so neither save hook nor <leader>f repeats
    -- it. timeout_ms only binds the sync path.
    default_format_opts = { timeout_ms = 500, lsp_format = 'fallback' },
    format_on_save = function(bufnr)
        if not format_on_save_enabled or is_ignored(bufnr) or SLOW_FORMATTERS_BY_FT[vim.bo[bufnr].filetype] then return end
        return {}
    end,
    format_after_save = function(bufnr)
        if not format_on_save_enabled or is_ignored(bufnr) or not SLOW_FORMATTERS_BY_FT[vim.bo[bufnr].filetype] then return end
        return {}
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
        proto = { 'buf' },
        python = { 'ruff_fix', 'ruff_format', 'ruff_organize_imports' },
        sql = { 'sqlfluff' },
        tf = { 'terraform_fmt' },
        typescript = biome_or_prettier,
        typescriptreact = biome_or_prettier,
        yaml = { 'prettier' },
        ['yaml.docker-compose'] = { 'prettier' },
        ['yaml.github'] = { 'prettier' },
        ['yaml.gitlab'] = { 'prettier' },
        zig = { 'zigfmt' },
    },
    formatters = {
        -- Prose stays on one line: a paragraph is one line, and the reader wraps
        -- at a width we cannot know. Hard wraps re-flow the whole block on the
        -- next edit and bury the real change in the diff. The flag overrides a
        -- project config that sets proseWrap: always, and is inert for the
        -- non-prose filetypes that share this formatter.
        prettier = {
            prepend_args = { '--prose-wrap', 'preserve' },
        },
        jsonnetfmt = {
            args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
        },
        sqlfluff = {
            require_cwd = false,
        },
    },
}

-- conform reads the current mode itself and formats only the selection when
-- called from visual mode, so this covers both whole-buffer and range.
vim.keymap.set('', '<leader>f', function()
    if is_ignored(0) then return end
    require('conform').format { async = true }
end, { desc = '[F]ormat buffer' })

require('toggle').map('<leader>tf', {
    name = 'Format on Save',
    get = function() return format_on_save_enabled end,
    set = function(state) format_on_save_enabled = state end,
})
