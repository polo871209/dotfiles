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
