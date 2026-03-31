return {
  cmd = { 'yaml-language-server', '--stdio' },
  filetypes = { 'yaml', 'yaml.docker-compose', 'yaml.gitlab' },
  root_markers = { '.git' },
  settings = {
    yaml = {
      validate = false,
      completion = true,
      hover = true,
      schemaStore = {
        enable = false, -- Use SchemaStore.nvim instead
        url = '',
      },
      format = {
        enable = true,
        singleQuote = false,
        bracketSpacing = true,
      },
      schemas = require('schemastore').yaml.schemas {
        select = {
          'kustomization.yaml',
          'GitHub Workflow',
          'docker-compose.yml',
          'gitlab-ci',
          'prometheus.json',
        },
      },
      customTags = {
        '!reference sequence',
        '!secret scalar',
        '!include scalar',
      },
    },
  },
}
