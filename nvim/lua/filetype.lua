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
