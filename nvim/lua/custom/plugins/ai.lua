return {
  {
    'olimorris/codecompanion.nvim', -- The KING of AI programming
    dependencies = {
      'j-hui/fidget.nvim', -- Display status
      'ravitemer/codecompanion-history.nvim', -- Save and load conversation history
      {
        'ravitemer/mcphub.nvim', -- Manage MCP servers
        cmd = 'MCPHub',
        build = 'npm install -g mcp-hub@latest',
        config = true,
      },
      {
        'zbirenbaum/copilot.lua',
        -- Copilot Auth
        cmd = 'Copilot',
        event = 'InsertEnter',
        config = function()
          require('copilot').setup {}
        end,
      },
      {
        'Davidyz/VectorCode', -- Index and search code in your repositories
        version = '*',
        -- pipx install vectorcode
        build = 'pipx upgrade vectorcode',
        dependencies = { 'nvim-lua/plenary.nvim' },
      },
      {
        'echasnovski/mini.diff', -- Inline and better diff over the default
        config = function()
          local diff = require 'mini.diff'
          diff.setup {
            -- Disabled by default
            source = diff.gen_source.none(),
          }
        end,
      },
      {
        'HakonHarnes/img-clip.nvim', -- Share images with the chat buffer
        event = 'VeryLazy',
        cmd = 'PasteImage',
        opts = {
          filetypes = {
            codecompanion = {
              prompt_for_file_name = false,
              template = '[Image]($FILE_PATH)',
              use_absolute_path = true,
            },
          },
        },
      },
    },
    opts = {
      extensions = {
        history = {
          enabled = true,
          opts = {
            keymap = 'gh',
            auto_generate_title = true,
            continue_last_chat = false,
            delete_on_clearing_chat = false,
            picker = 'snacks',
            enable_logging = false,
            dir_to_save = vim.fn.stdpath 'data' .. '/codecompanion-history',
          },
        },
        mcphub = {
          callback = 'mcphub.extensions.codecompanion',
          opts = {
            make_vars = true,
            make_slash_commands = true,
            show_result_in_chat = true,
          },
        },
        vectorcode = {
          opts = {
            add_tool = true,
          },
        },
      },
      adapters = {
        copilot = function()
          return require('codecompanion.adapters').extend('copilot', {
            schema = {
              model = {
                default = 'gemini-2.5-pro',
              },
            },
          })
        end,
      },
      prompt_library = {},
      strategies = {
        chat = {
          adapter = 'copilot',
          roles = {
            user = 'Po',
          },
          slash_commands = {
            ['buffer'] = {
              keymaps = {
                modes = {
                  i = '<C-b>',
                },
              },
            },
            ['fetch'] = {
              keymaps = {
                modes = {
                  i = '<C-f>',
                },
              },
            },
            ['help'] = {
              opts = {
                max_lines = 1000,
              },
            },
            ['image'] = {
              keymaps = {
                modes = {
                  i = '<C-i>',
                },
              },
              opts = {
                dirs = { '~/Documents/Screenshots' },
              },
            },
          },
          tools = {
            opts = {
              auto_submit_success = false,
              auto_submit_errors = false,
            },
          },
        },
        inline = { adapter = 'copilot' },
      },
      display = {
        action_palette = {
          provider = 'default',
        },
        chat = {
          -- show_references = true,
          -- show_header_separator = false,
          -- show_settings = false,
        },
        diff = {
          provider = 'mini_diff',
        },
      },
      opts = {
        log_level = 'DEBUG',
      },
    },
  },
}
