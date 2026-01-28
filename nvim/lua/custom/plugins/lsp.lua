return {
  {
    'neovim/nvim-lspconfig',
    dependencies = {
      { 'mason-org/mason.nvim', opts = {} },
      'mason-org/mason-lspconfig.nvim',
      'WhoIsSethDaniel/mason-tool-installer.nvim',

      -- Useful status updates for LSP.
      -- NOTE: `opts = {}` is the same as calling `require('fidget').setup({})`
      { 'j-hui/fidget.nvim',    opts = {} },

      -- JSON/YAML schema support
      'b0o/SchemaStore.nvim',
    },
    config = function()
      --  This function gets run when an LSP attaches to a particular buffer.
      --    That is to say, every time a new file is opened that is associated with
      --    an lsp (for example, opening `main.rs` is associated with `rust_analyzer`) this
      --    function will be executed to configure the current buffer
      vim.api.nvim_create_autocmd('LspAttach', {
        group = vim.api.nvim_create_augroup('lsp-attach', { clear = true }),
        callback = function(event)
          vim.keymap.set('n', 'grn', vim.lsp.buf.rename, { buffer = event.buf, desc = 'LSP: [R]e[n]ame' })
          vim.keymap.set({ 'n', 'x' }, 'gra', vim.lsp.buf.code_action,
            { buffer = event.buf, desc = 'LSP: [G]oto Code [A]ction' })
          vim.keymap.set('n', 'grD', vim.lsp.buf.declaration, { buffer = event.buf, desc = 'LSP: [G]oto [D]eclaration' })
          vim.keymap.set('n', '<leader>d', vim.lsp.buf.hover, { desc = 'LSP: [D]ocumentation (Hover)' })

          local client = vim.lsp.get_client_by_id(event.data.client_id)
          if client and client:supports_method(vim.lsp.protocol.Methods.textDocument_documentHighlight, event.buf) then
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
                vim.api.nvim_clear_autocmds({ group = 'lsp-highlight', buffer = event2.buf })
              end,
            })
          end
        end,
      })

      -- Diagnostic Config
      vim.diagnostic.config({
        virtual_text = true,
        signs = {
          text = {
            [vim.diagnostic.severity.ERROR] = '',
            [vim.diagnostic.severity.WARN] = '',
            [vim.diagnostic.severity.INFO] = '',
            [vim.diagnostic.severity.HINT] = '',
          },
        },
      })

      vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = '[D]iagnostic [Q]uickfix' })

      local servers = {
        bashls = {},
        cue = {},
        gopls = {},
        jsonls = {},
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
                -- Disable built-in schemaStore, use SchemaStore.nvim instead for better control
                enable = false,
                url = '',
              },
              format = {
                enable = true,
                singleQuote = false,
                bracketSpacing = true,
              },
              schemas = require('schemastore').yaml.schemas({
                -- Only load schemas you actually use for better performance
                select = {
                  'kustomization.yaml',
                  'GitHub Workflow',
                  'docker-compose.yml',
                  'gitlab-ci',
                  'prometheus.json'
                },
                -- Add custom schema mappings
                -- extra = {
                --   {
                --     name = 'Kubernetes',
                --     description = 'Kubernetes resource definitions',
                --     url =
                --     'https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/master-standalone-strict/all.json',
                --     fileMatch = { 'deploy*.yaml', 'deploy*.yml', 'k8s/*.yaml', 'k8s/*.yml' },
                --   },
                -- },
              }),
              customTags = {
                -- Support for common YAML tags
                '!reference sequence',
                '!secret scalar',
                '!include scalar',
              },
            },
          },
        },
        lua_ls = {
          settings = {
            Lua = {
              completion = {
                callSnippet = 'Replace',
              },
              diagnostics = {
                disable = { 'missing-fields' },
                globals = { 'vim' },
              },
            },
          },
        },
      }

      ---@type MasonLspconfigSettings
      ---@diagnostic disable-next-line: missing-fields
      require('mason-lspconfig').setup({
        automatic_enable = vim.tbl_keys(servers or {}),
        handlers = {
          function(server_name)
            vim.lsp.config(server_name, servers[server_name] or {})
          end,
        },
      })

      local ensure_installed = vim.tbl_extend('keep', vim.tbl_keys(servers), {
        'buildifier',
        'stylua',
        'prettier',
      })
      require('mason-tool-installer').setup({ ensure_installed = ensure_installed })

      vim.lsp.enable('nushell')
    end,
  },
  -- other languages plugins
  {
    'ray-x/go.nvim',
    dependencies = { -- optional packages
      'ray-x/guihua.lua',
    },
    opts = {
      -- lsp_keymaps = false,
      -- other options
    },
    config = function(_, opts)
      require('go').setup(opts)
      local format_sync_grp = vim.api.nvim_create_augroup('GoFormat', {})
      vim.api.nvim_create_autocmd('BufWritePre', {
        pattern = '*.go',
        callback = function()
          require('go.format').goimports()
        end,
        group = format_sync_grp,
      })
    end,
    ft = { 'go', 'gomod' },
    build = ':lua require("go.install").update_all_sync()', -- if you need to install/update all binaries
  },
  {
    "pmizio/typescript-tools.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
    opts = {},
  },
  {
    'folke/lazydev.nvim',
    ft = 'lua',
    opts = {
      library = {
        -- Load luvit types when the `vim.uv` word is found
        { path = '${3rd}/luv/library', words = { 'vim%.uv' } },
      },
    },
  },
}
