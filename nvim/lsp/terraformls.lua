return {
  cmd = { 'terraform-ls', 'serve' },
  filetypes = { 'terraform', 'hcl', 'tf' },
  root_markers = { '.terraform', '.git' },
  settings = {
    terraform = {
      format = { enabled = true },
      lint = { enabled = true },
    },
  },
}
