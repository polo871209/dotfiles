return {
    cmd = { 'jsonnet-language-server', '-t' },
    filetypes = { 'jsonnet', 'libsonnet' },
    -- jsonnetfile.json marks the jsonnet-bundler project whose vendor/ tree
    -- holds the imports.
    root_markers = { 'jsonnetfile.json', '.git' },
}
