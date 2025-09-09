return {
  {
    'folke/trouble.nvim',
    cmd = 'Trouble',
    keys = {
      { '<leader>tt', '<cmd>Trouble diagnostics toggle<cr>', desc = '[T]rouble [T]oggle' },
      { '<leader>tq', '<cmd>Trouble quickfix<cr>', desc = '[T]rouble [Q]uickfix' },
    },
  },
}
