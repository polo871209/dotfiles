return { -- Autocompletion
  'saghen/blink.cmp',
  dependencies = {
    {
      'zbirenbaum/copilot.lua',
      cmd = 'Copilot',
      event = 'InsertEnter',
      config = function()
        require('copilot').setup({
          suggestion = { enabled = false },
          panel = { enabled = false },
        })
      end,
    },
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
      -- By default, you may press `<c-space>` to show the documentation.
      -- Optionally, set `auto_show = true` to show the documentation after a delay.
      documentation = { auto_show = true, auto_show_delay_ms = 500 },
      ghost_text = {
        enabled = true,
      },
    },

    sources = {
      default = { 'path', 'buffer', 'copilot', 'lsp' },
      providers = {
        path = {
          score_offset = 100,
        },
        buffer = {
          score_offset = 75,
        },
        copilot = {
          name = 'copilot',
          module = 'blink-copilot',
          score_offset = 50,
          async = true,
        },
        lsp = {
          score_offset = 25,
        },
      },
    },

    fuzzy = { implementation = 'prefer_rust_with_warning' },

    -- Shows a signature help window while you type arguments for a function
    signature = { enabled = true },
  },

  opts_extend = { "sources.default" }
}
