return {
  {
    'olimorris/codecompanion.nvim', -- The KING of AI programming
    event = 'VeryLazy',
    dependencies = {
      'j-hui/fidget.nvim', -- Display status
      'ravitemer/codecompanion-history.nvim', -- Save and load conversation history
      {
        'ravitemer/mcphub.nvim', -- Manage MCP servers
        cmd = 'MCPHub',
        build = 'npm update -g mcp-hub@latest',
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
        'Davidyz/VectorCode',
        version = '*',
        build = 'uv tool upgrade vectorcode',
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
        -- https://github.com/Davidyz/VectorCode/blob/main/docs/cli.md#getting-started
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
                default = 'claude-sonnet-4',
              },
            },
          })
        end,
      },
      prompt_library = {
        ['Word'] = {
          strategy = 'inline',
          description = 'documentation and code improvement assistant',
          opts = {
            index = 3,
            is_default = true,
            is_slash_cmd = false,
            user_prompt = false,
            modes = { 'v' },
            short_name = 'word',
          },
          prompts = {
            {
              role = 'system',
              content = [[You are a documentation and code improvement assistant. Please rewrite the provided content to enhance clarity, conciseness, and structure while preserving all original meaning and technical accuracy.

**Improvement Guidelines:**
• **Clarity**: Use clear, direct language and eliminate ambiguity
• **Structure**: Organize with logical flow and consistent formatting
• **Conciseness**: Remove redundancy while maintaining completeness
• **Readability**: Improve grammar, word choice, and sentence construction
• **Technical Accuracy**: Preserve all original information and functionality

**Focus Areas:**
• Documentation (README files, API docs, user guides)
• Code comments and inline documentation
• Log messages and debug statements
• Error messages and notifications
• Configuration files and technical specifications

**Enhancement Examples:**
Before: `logger.info("start process")`
After: `logger.info("Starting data processing")`

Before: `// do the thing`
After: `// Process user input and validate data`

Please maintain the original intent while making the content more professional and accessible.]],
              opts = {
                visible = false,
              },
            },
          },
        },
      },
      strategies = {
        chat = {
          adapter = 'copilot',
          roles = {
            user = 'Po',
          },
          variables = {
            ['buffer'] = {
              opts = {
                default_params = 'watch',
              },
            },
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
