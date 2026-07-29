return {
    cmd = { 'yaml-language-server', '--stdio' },
    filetypes = { 'yaml', 'yaml.docker-compose', 'yaml.gitlab', 'yaml.github' },
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
                    'Ansible Playbook',
                    'Ansible Tasks File',
                    'Ansible Vars File',
                    'Ansible Meta',
                    'Ansible Meta Runtime',
                    'Ansible Argument Specs',
                    'Ansible Requirements',
                    'Ansible Inventory',
                    'Ansible Collection Galaxy',
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
