-- Size-based detection wins over every other rule, so a huge file opens as
-- `bigfile` (see after/ftplugin/bigfile.lua) and nothing expensive attaches.
-- Returning nil for normal files lets detection carry on.
--
-- The cutoff tracks the language server, not nvim: a 30MB go file opens in
-- ~250ms with treesitter attached, while gopls took 4.3GB on it (jsonls 309MB
-- on 9MB of json). Below this, highlighting is worth more than the savings.
local BIGFILE_SIZE = 10 * 1024 * 1024

vim.filetype.add {
    pattern = {
        ['.*'] = {
            function(path)
                if not path then return end
                local stat = vim.uv.fs_stat(path)
                if stat and stat.type == 'file' and stat.size > BIGFILE_SIZE then return 'bigfile' end
            end,
            { priority = math.huge },
        },
    },
}

vim.filetype.add {
    filename = {
        ['.envrc'] = 'sh',
        ['BUILD'] = 'bzl',
        ['BUILD.bazel'] = 'bzl',
        ['WORKSPACE'] = 'bzl',
        ['WORKSPACE.bazel'] = 'bzl',
        ['MODULE.bazel'] = 'bzl',
    },
    extension = {
        bzl = 'bzl',
        j2 = 'jinja',
        mdx = 'markdown',
    },
    pattern = {
        -- lsp/yamlls.lua and plugin/format.lua target these compound
        -- filetypes for schema/formatter selection; nvim has no builtin
        -- ftdetect for them, so without this they never fire.
        ['.*/%.github/workflows/.*%.ya?ml'] = 'yaml.github',
        ['.*docker%-compose[^/]*%.ya?ml'] = 'yaml.docker-compose',
        ['.*%.gitlab%-ci%.ya?ml'] = 'yaml.gitlab',
    },
}

-- Base jinja query keeps jinja_inline/comment injections; add properties
-- injection so the non-jinja text (config keys/values) gets highlighted too.
vim.treesitter.query.set(
    'jinja',
    'injections',
    [[
((inline) @injection.content
  (#set! injection.language "jinja_inline"))

((comment) @injection.content
  (#set! injection.language "comment"))

((content) @injection.content
  (#set! injection.language "properties")
  (#set! injection.combined))
]]
)
