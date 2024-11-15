return {
  'folke/trouble.nvim',
  cmd = 'Trouble',
  keys = {
    { '<leader>tt', '<cmd>Trouble diagnostics toggle<cr>', desc = '[T]rouble [T]oggle' },
    { '<leader>tq', '<cmd>Trouble quickfix<cr>', desc = '[T]rouble [Q]uickfix' },
  },
  opts = {
    action_key = {
      use_diagnostic_signs = true,
      action_keys = {
        close = { 'q', '<esc>' },
      },
    },
  },
}
