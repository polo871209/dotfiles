vim.pack.add {
    'https://github.com/stevearc/conform.nvim',
    'https://github.com/NMAC427/guess-indent.nvim',
}
require('guess-indent').setup {}

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

local BIOME_CONFIGS = { 'biome.json', 'biome.jsonc', '.biome.json', '.biome.jsonc' }
local OXFMT_CONFIGS = { '.oxfmtrc.json', '.oxfmtrc.jsonc', 'oxfmt.config.ts' }

---@param dir string
---@return string
local function real(dir) return vim.uv.fs_realpath(dir) or dir end

---@param bufnr integer
---@return string
local function real_dir(bufnr) return real(vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr))) end

---@param dir string
---@return string?
local function prettier_root(dir) return require('conform.formatters.prettierd').cwd(nil, { dirname = dir }) end

---@param bufnr integer
---@return string[]
local function code_formatter(bufnr)
    local dir = real_dir(bufnr)
    if not vim.fs.root(dir, OXFMT_CONFIGS) then
        if vim.fs.root(dir, BIOME_CONFIGS) then return { 'biome' } end
        if prettier_root(dir) then return { 'prettier' } end
    end
    return { 'oxfmt' }
end

---@param bufnr integer
---@return string[]
local function markup_formatter(bufnr)
    local dir = real_dir(bufnr)
    if not vim.fs.root(dir, OXFMT_CONFIGS) and prettier_root(dir) then return { 'prettier' } end
    return { 'oxfmt' }
end

local autoformat = require 'autoformat'

require('conform').setup {
    notify_on_error = false,
    default_format_opts = { timeout_ms = 500, lsp_format = 'fallback' },
    format_on_save = function(bufnr)
        if not autoformat.on_save or autoformat.ignored(bufnr) or autoformat.slow(bufnr) then return end
        return {}
    end,
    format_after_save = function(bufnr)
        if not autoformat.on_save or autoformat.ignored(bufnr) or not autoformat.slow(bufnr) then return end
        return {}
    end,
    formatters_by_ft = {
        bzl = { 'buildifier' },
        c = { 'clang-format' },
        cpp = { 'clang-format' },
        css = code_formatter,
        cue = { 'cue_fmt' },
        go = { 'goimports' },
        html = code_formatter,
        javascript = code_formatter,
        javascriptreact = code_formatter,
        json = code_formatter,
        jsonc = code_formatter,
        jsonnet = { 'jsonnetfmt' },
        lua = { 'stylua' },
        markdown = markup_formatter,
        proto = { 'buf' },
        python = { 'ruff_fix', 'ruff_format', 'ruff_organize_imports' },
        rust = { 'rustfmt' },
        sql = { 'sqlfluff' },
        swift = { 'swiftlint', 'swift' },
        tf = { 'terraform_fmt' },
        toml = { 'taplo' },
        typescript = code_formatter,
        typescriptreact = code_formatter,
        yaml = markup_formatter,
        ['yaml.docker-compose'] = markup_formatter,
        ['yaml.github'] = markup_formatter,
        ['yaml.gitlab'] = markup_formatter,
        zig = { 'zigfmt' },
    },
    formatters = {
        -- Biome reads its configuration from the working directory, not from the formatted file's path.
        biome = {
            cwd = function(_, ctx) return vim.fs.root(real(ctx.dirname), BIOME_CONFIGS) end,
        },
        -- oxfmt reads .editorconfig only from its working directory, and conform defaults that to nvim's cwd.
        oxfmt = {
            cwd = function(_, ctx) return real(ctx.dirname) end,
        },
        prettier = {
            prepend_args = { '--prose-wrap', 'preserve' },
        },
        jsonnetfmt = {
            args = { '--indent', '0', '--max-blank-lines', '2', '--sort-imports', '--string-style', 's', '--comment-style', 's', '--no-pad-objects', '-' },
        },
        -- With --use-stdin, SwiftLint prints nothing when there is nothing to fix, so it edits a temp file instead.
        swiftlint = {
            stdin = false,
            args = { 'lint', '--fix', '--quiet', '--no-cache', '$FILENAME' },
            cwd = function(_, ctx) return vim.fs.root(real(ctx.dirname), '.swiftlint.yml') or real(ctx.dirname) end,
        },
    },
}

-- conform reads the current mode itself and formats only the selection when
-- called from visual mode, so this covers both whole-buffer and range.
vim.keymap.set('', '<leader>f', function()
    if autoformat.ignored(0) then return end
    require('conform').format { async = true }
end, { desc = '[F]ormat buffer' })

require('toggle').map('<leader>tf', {
    name = 'Format on Save',
    get = function() return autoformat.on_save end,
    set = function(state) autoformat.on_save = state end,
})
