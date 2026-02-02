return {
  {
    'zbirenbaum/copilot.lua',
    cmd = 'Copilot',
    event = 'InsertEnter',
    config = function()
      require('copilot').setup {
        suggestion = { enabled = false },
        panel = { enabled = false },
        copilot_model = 'claude-sonnet-4.5',
      }

      -- Toggle copilot with <leader>ai
      local copilot_enabled = true

      vim.keymap.set('n', '<leader>ai', function()
        vim.cmd 'Copilot toggle'
        copilot_enabled = not copilot_enabled

        local message = copilot_enabled and 'Copilot enabled' or 'Copilot disabled'
        Snacks.notifier.notify(message, 'warn', { title = 'Copilot' })
      end, { desc = 'Toggle Copilot' })
    end,
  },
  {
    'saghen/blink.cmp',
    dependencies = {
      'zbirenbaum/copilot.lua',
      'fang2hou/blink-copilot',
    },
    version = '1.*',
    --- @module 'blink.cmp'
    --- @type blink.cmp.Config
    opts = {
      keymap = {
        preset = 'super-tab',
      },

      completion = {
        ghost_text = {
          enabled = true,
        },
        list = {
          max_items = 20,
        },
        trigger = {
          show_on_insert_on_trigger_character = true,
          show_on_trigger_character_length = 1,
        },
      },

      sources = {
        default = { 'path', 'buffer', 'copilot', 'lsp' },
        providers = {
          path = {
            score_offset = 100,
            max_items = 5,
            opts = {
              trailing_slash = false,
              label_trailing_slash = false,
            },
          },
          buffer = {
            score_offset = 75,
            max_items = 5,
            min_keyword_length = 3,
          },
          copilot = {
            name = 'copilot',
            module = 'blink-copilot',
            score_offset = 50,
            async = true,
          },
          lsp = {
            score_offset = 25,
            max_items = 10,
          },
        },
      },

      fuzzy = { implementation = 'prefer_rust_with_warning' },

      -- Signature help while typing
      signature = { enabled = true },
    },

    opts_extend = { 'sources.default' },
  },
}
