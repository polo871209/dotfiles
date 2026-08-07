return {
    cmd = { 'terraform-ls', 'serve' },
    filetypes = { 'hcl', 'tf', 'terraform-vars' },
    root_markers = { '.terraform', '.git' },
    settings = {
        terraform = {
            format = { enabled = true },
            lint = { enabled = true },
        },
    },
}
