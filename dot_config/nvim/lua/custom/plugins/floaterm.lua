return {
  'voldikss/vim-floaterm',
  event = 'VeryLazy',
  config = function()
    -- Set the width and height of the Floaterm window
    vim.g.floaterm_width = 0.99
    vim.g.floaterm_height = 0.4
    vim.g.floaterm_position = 'bottom'

    -- Key mappings for normal mode and terminal mode
    vim.api.nvim_set_keymap('n', '<leader>j', ':FloatermToggle<CR>', { noremap = true, silent = true })
    vim.api.nvim_set_keymap('t', '<leader>j', '<C-\\><C-n>:FloatermToggle<CR>', { noremap = true, silent = true })
  end,
}
