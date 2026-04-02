vim.pack.add {
  'https://github.com/folke/todo-comments.nvim',
  'https://github.com/wurli/visimatch.nvim',
  'https://github.com/MeanderingProgrammer/render-markdown.nvim',
  'https://github.com/folke/which-key.nvim',
  'https://github.com/stevearc/quicker.nvim',
  'https://github.com/3rd/image.nvim',
}

require('todo-comments').setup { signs = false }
require('visimatch').setup {}
require('render-markdown').setup {}

require('which-key').setup {
  delay = 200,
  spec = {
    { '<leader><leader>', group = 'OpenCode Ask' },
    { '<leader>b', group = 'De[B]ug' },
    { '<leader>g', group = '[G]it' },
    { '<leader>m', group = 'Split/Join' },
    { '<leader>p', group = 'vim [P]ack' },
    { '<leader>s', group = '[S]earch' },
    { '<leader>t', group = '[T]oggle' },
    { 'g', group = 'LSP Actions', mode = { 'n' } },
  },
}

require('quicker').setup {}

require('image').setup {
  backend = 'kitty',
  processor = 'magick_cli',
  integrations = {
    markdown = {
      enabled = true,
      only_render_image_at_cursor = true,
    },
  },
  max_height_window_percentage = 50,
  hijack_file_patterns = { '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif' },
}
