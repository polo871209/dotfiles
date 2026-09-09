return {
    cmd = { 'terraform-ls', 'serve' },
    -- vim.filetype.detect.tf returns `terraform` on the first non-comment,
    -- non-blank line, so only an empty .tf file stays `tf` and listing `tf`
    -- alone attaches to empty files and nothing else.
    filetypes = { 'terraform', 'tf', 'terraform-vars', 'hcl' },
    -- .terraform appears only after `terraform init`, so on a fresh clone it
    -- cannot mark the root. The lock file is committed and marks the same
    -- directory.
    root_markers = { '.terraform.lock.hcl', '.terraform', '.git' },
    -- terraform-ls does not implement workspace/didChangeConfiguration, so a
    -- `settings` table is read by nobody. Static settings must ride along with
    -- the initialize request instead.
    init_options = {
        experimentalFeatures = { prefillRequiredFields = true },
        ignoreSingleFileWarning = true,
    },
}
