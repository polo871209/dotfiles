return {
  {
    'neovim/nvim-lspconfig',
    dependencies = {
      { 'mason-org/mason.nvim', opts = {} },
      'WhoIsSethDaniel/mason-tool-installer.nvim',
      { 'j-hui/fidget.nvim', opts = {} }, -- LSP status updates
      'b0o/SchemaStore.nvim', -- JSON/YAML schemas
    },
    config = function()
      -- LSP keymaps and highlighting
      vim.api.nvim_create_autocmd('LspAttach', {
        group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
        callback = function(event)
          local map = function(keys, func, desc, mode)
            mode = mode or 'n'
            vim.keymap.set(mode, keys, func, { buffer = event.buf, desc = 'LSP: ' .. desc })
          end

          map('grn', vim.lsp.buf.rename, '[R]e[n]ame')
          map('gra', vim.lsp.buf.code_action, '[G]oto Code [A]ction', { 'n', 'x' })
          map('<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ction', { 'n', 'x' })
          map('grD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
          map('<leader>d', vim.lsp.buf.hover, '[D]ocumentation (Hover)')

          -- Highlight references under cursor
          local client = vim.lsp.get_client_by_id(event.data.client_id)
          if client and client:supports_method('textDocument/documentHighlight', event.buf) then
            local highlight_augroup = vim.api.nvim_create_augroup('lsp-highlight', { clear = false })
            vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
              buffer = event.buf,
              group = highlight_augroup,
              callback = vim.lsp.buf.document_highlight,
            })

            vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
              buffer = event.buf,
              group = highlight_augroup,
              callback = vim.lsp.buf.clear_references,
            })

            vim.api.nvim_create_autocmd('LspDetach', {
              group = vim.api.nvim_create_augroup('lsp-detach', { clear = true }),
              callback = function(event2)
                vim.lsp.buf.clear_references()
                vim.api.nvim_clear_autocmds { group = 'lsp-highlight', buffer = event2.buf }
              end,
            })
          end

          -- Toggle inlay hints
          if client and client:supports_method('textDocument/inlayHint', event.buf) then
            map('<leader>th', function() vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled { bufnr = event.buf }) end, '[T]oggle Inlay [H]ints')
          end
        end,
      })

      -- Diagnostic configuration
      vim.diagnostic.config {
        update_in_insert = false,
        severity_sort = true,
        float = { border = 'rounded', source = 'if_many' },
        underline = { severity = vim.diagnostic.severity.ERROR },
        virtual_text = true, -- Text at end of line
        virtual_lines = false, -- Text underneath line
        jump = { float = true }, -- Auto-open float on jump
      }

      vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostic [Q]uickfix list' })

      local servers = {
        bashls = {},
        cue = {},
        gopls = {},
        jsonls = {},
        nushell = {},
        starpls = {
          filetypes = { 'bzl', 'bazel', 'starlark' },
        },
        ty = {
          settings = {
            ty = {
              inlayHints = {
                variableTypes = false,
                callArgumentNames = false,
              },
            },
          },
        },
        taplo = {},
        terraformls = {
          filetypes = { 'terraform', 'hcl', 'tf' },
          settings = {
            terraform = {
              format = {
                enabled = true,
              },
              lint = {
                enabled = true,
              },
            },
          },
        },
        yamlls = {
          settings = {
            yaml = {
              validate = false,
              completion = true,
              hover = true,
              schemaStore = {
                enable = false, -- Use SchemaStore.nvim
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
                -- Custom schema mappings
                -- extra = {
                --   {
                --     name = 'Kubernetes',
                --     description = 'Kubernetes resource definitions',
                --     url = 'https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/master-standalone-strict/all.json',
                --     fileMatch = { 'deploy*.yaml', 'deploy*.yml', 'k8s/*.yaml', 'k8s/*.yml' },
                --   },
                -- },
              },
              customTags = {
                '!reference sequence',
                '!secret scalar',
                '!include scalar',
              },
            },
          },
        },
        -- Lua LSP configuration
        lua_ls = {
          on_init = function(client)
            if client.workspace_folders then
              local path = client.workspace_folders[1].name
              if path ~= vim.fn.stdpath 'config' and (vim.uv.fs_stat(path .. '/.luarc.json') or vim.uv.fs_stat(path .. '/.luarc.jsonc')) then return end
            end

            client.config.settings.Lua = vim.tbl_deep_extend('force', client.config.settings.Lua, {
              runtime = {
                version = 'LuaJIT',
                path = { 'lua/?.lua', 'lua/?/init.lua' },
              },
              workspace = {
                checkThirdParty = false,
                library = vim.api.nvim_get_runtime_file('', true),
              },
              completion = {
                callSnippet = 'Replace',
              },
              diagnostics = {
                disable = { 'missing-fields' },
                globals = { 'vim' },
              },
              hint = {
                enable = false,
              },
            })
          end,
          settings = {
            Lua = {
              hint = {
                enable = false,
              },
            },
          },
        },
      }

      -- Enable configured servers
      for name, server in pairs(servers) do
        vim.lsp.config(name, server)
        vim.lsp.enable(name)
      end

      -- Ensure Mason packages are installed
      local mason_packages = {
        -- LSP servers
        'bash-language-server',
        'cuelsp',
        'gopls',
        'json-lsp',
        'starpls',
        'ty',
        'taplo',
        'terraform-ls',
        'yaml-language-server',
        'lua-language-server',
        -- Additional tools
        'buildifier',
        'stylua',
        'prettier',
      }
      require('mason-tool-installer').setup { ensure_installed = mason_packages }
    end,
  },
  {
    'pmizio/typescript-tools.nvim',
    dependencies = { 'nvim-lua/plenary.nvim', 'neovim/nvim-lspconfig' },
    opts = {},
  },
}
