return {
  'folke/flash.nvim',
  event = 'VeryLazy',
  opts = {},
  -- stylua: ignore
  keys = {
    { "s", mode = { "n" }, function() require("flash").jump() end, desc = "Flash" },
    { "S", mode = { "n" }, function() require("flash").treesitter() end, desc = "Flash Treesitter" },
  },
}
