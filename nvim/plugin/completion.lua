vim.pack.add {
  { src = 'https://github.com/saghen/blink.cmp', version = vim.version.range '1.x' },
}

require('blink.cmp').setup {
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
    },
  },

  sources = {
    default = { 'path', 'buffer', 'lsp' },
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
      lsp = {
        score_offset = 25,
        max_items = 10,
      },
    },
  },

  fuzzy = { implementation = 'prefer_rust_with_warning' },

  signature = { enabled = true },
}
