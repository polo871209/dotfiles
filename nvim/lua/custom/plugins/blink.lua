-- Don't load completions in practice mode
if vim.g.practice_mode then
  return {}
end

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
      ghost_text = {
        enabled = true,
      },
      list = {
        max_items = 20, -- Limit total items shown
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
          max_items = 5, -- Limit path suggestions
          opts = {
            trailing_slash = false,
            label_trailing_slash = false,
          },
        },
        buffer = {
          score_offset = 75,
          max_items = 5,          -- Limit number of buffer completions
          min_keyword_length = 3, -- Don't trigger on 1-2 character inputs
        },
        copilot = {
          name = 'copilot',
          module = 'blink-copilot',
          score_offset = 50,
          async = true,
        },
        lsp = {
          score_offset = 25,
          max_items = 10, -- Limit LSP completions
        },
      },
    },

    fuzzy = { implementation = 'prefer_rust_with_warning' },

    -- Shows a signature help window while you type arguments for a function
    signature = { enabled = true },
  },

  opts_extend = { "sources.default" }
}
