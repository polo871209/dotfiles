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

local biome_configs = { 'biome.json', 'biome.jsonc', '.biome.json', '.biome.jsonc' }
local function biome_or_prettier(bufnr)
    local path = vim.api.nvim_buf_get_name(bufnr)
    if vim.fs.find(biome_configs, { upward = true, path = path })[1] then return { 'biome' } end
    if require('conform.formatters.prettierd').cwd(nil, { dirname = vim.fs.dirname(path) }) then return { 'prettier' } end
    return { 'biome' }
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
        swift = { 'swiftlint', lsp_format = 'last' },
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
        -- conform's biome runs in nvim's cwd when the file has no biome config, and biome then reads that cwd's biome.json.
        biome = {
            cwd = function(_, ctx) return vim.fs.root(ctx.dirname, biome_configs) or ctx.dirname end,
            args = function(_, ctx)
                if vim.fs.root(ctx.dirname, biome_configs) then return { 'format', '--stdin-file-path', '$FILENAME' } end
                local indent_style = vim.bo[ctx.buf].expandtab and 'space' or 'tab'
                return { 'format', '--stdin-file-path', '$FILENAME', '--indent-style', indent_style, '--indent-width', tostring(ctx.shiftwidth) }
            end,
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
            cwd = function(_, ctx) return vim.fs.root(ctx.buf, '.swiftlint.yml') or ctx.dirname end,
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
