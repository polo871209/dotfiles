return {
  'folke/noice.nvim',
  event = 'VeryLazy',
  dependencies = {
    'MunifTanjim/nui.nvim',
  },
  opts = {
    lsp = {
      -- Override markdown rendering for cmp
      override = {
        ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
        ['vim.lsp.util.stylize_markdown'] = true,
      },
    },
    -- Presets for easier config
    presets = {
      bottom_search = true, -- Classic bottom cmdline for search
      command_palette = true, -- Cmdline and popupmenu together
      long_message_to_split = true, -- Long messages go to split
      inc_rename = false, -- Input dialog for inc-rename
      lsp_doc_border = false, -- Border for hover/signature docs
    },
  },
}
