return {
  'nvim-pack/nvim-spectre',

  dependencies = {
    'BurntSushi/ripgrep',
    'nvim-tree/nvim-web-devicons',
  },

  build = false,
  cmd = 'Spectre',
  opts = { open_cmd = 'noswapfile vnew' },
  -- stylua: ignore
  keys = {
    { "<leader>sr", function() require("spectre").open() end, desc = "[S]earch [R]eplace" },
  },
}
