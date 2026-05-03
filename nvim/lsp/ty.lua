return {
  cmd = { 'ty', 'server' },
  filetypes = { 'python' },
  root_markers = { 'pyproject.toml', 'setup.py', 'setup.cfg', '.git' },
  settings = {
    ty = {
      inlayHints = {
        variableTypes = false,
        callArgumentNames = false,
      },
    },
  },
}
