return {
  cmd = {
    'clangd',
    '--background-index',
    '--header-insertion=iwyu',
  },
  filetypes = { 'c', 'cpp', 'objc', 'objcpp' },
  root_markers = { '.clangd', 'compile_commands.json', 'compile_flags.txt', '.git' },
}
