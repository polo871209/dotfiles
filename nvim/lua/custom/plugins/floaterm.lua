return {
  'voldikss/vim-floaterm',
  event = 'VeryLazy',
  config = function()
    vim.g.floaterm_title = '🦍🦍🦍🦍 WE STRONK 🦍🦍🦍🦍 WE APE 🦍🦍🦍🦍'
    vim.g.floaterm_width = 0.99
    vim.g.floaterm_height = 0.99
    vim.g.floaterm_position = 'bottom'
    vim.g.floaterm_titleposition = 'center'
    vim.g.floaterm_borderchars = '─│─│╭╮╯╰'

    -- Key mappings for normal mode and terminal mode
    vim.api.nvim_set_keymap('n', '<leader>j', ':FloatermToggle<CR>', { noremap = true, silent = true, desc = '[J]FloatermToggle' })
    vim.api.nvim_set_keymap('t', '<leader>j', '<C-\\><C-n>:FloatermToggle<CR>', { noremap = true, silent = true })
  end,
}
