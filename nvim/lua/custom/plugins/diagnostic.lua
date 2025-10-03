return {
  {
    'folke/trouble.nvim',
    opts = {},
    cmd = 'Trouble',
    keys = {
      { '<leader>tt', '<cmd>Trouble diagnostics toggle filter.buf=0<cr>', desc = '[T]rouble [T]oggle' },
      { '<leader>tq', '<cmd>Trouble qflist toggle<cr>', desc = '[T]rouble [Q]uickfix' },
    },
  },
}
