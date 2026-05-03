vim.pack.add {
  'https://github.com/folke/todo-comments.nvim',
  'https://github.com/wurli/visimatch.nvim',
  'https://github.com/folke/which-key.nvim',
  'https://github.com/stevearc/quicker.nvim',
}

require('todo-comments').setup { signs = false }
require('visimatch').setup {}

require('which-key').setup {
  delay = 200,
  spec = {
    { '<leader><leader>', group = 'OpenCode Ask' },
    { '<leader>b', group = 'De[B]ug' },
    { '<leader>g', group = '[G]it' },
    { '<leader>p', group = 'vim [P]ack' },
    { '<leader>r', group = '[R]un Code' },
    { '<leader>s', group = '[S]earch' },
    { '<leader>t', group = '[T]oggle' },
  },
}

require('quicker').setup {}

local image_loaded = false
local render_markdown_loaded = false

local function load_image()
  if image_loaded then return end
  image_loaded = true
  vim.pack.add { 'https://github.com/3rd/image.nvim' }
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
end

vim.api.nvim_create_autocmd('FileType', {
  pattern = 'markdown',
  callback = function()
    load_image()
    if render_markdown_loaded then return end
    render_markdown_loaded = true
    vim.pack.add { 'https://github.com/MeanderingProgrammer/render-markdown.nvim' }
    require('render-markdown').setup {}
  end,
})

vim.api.nvim_create_autocmd('BufReadPre', {
  pattern = { '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif' },
  callback = load_image,
})
