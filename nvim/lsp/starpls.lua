return {
    cmd = { 'starpls' },
    -- .star files detect as `starlark`, which starpls serves as well.
    filetypes = { 'bzl', 'starlark' },
    root_markers = { 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel', '.git' },
}
