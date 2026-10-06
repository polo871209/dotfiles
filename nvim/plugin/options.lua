vim.o.number = true
vim.o.relativenumber = true

vim.o.mouse = 'a'

vim.o.showmode = false

vim.schedule(function() vim.o.clipboard = 'unnamedplus' end)

vim.o.breakindent = true

vim.o.undofile = true

vim.o.swapfile = false

vim.o.ignorecase = true
vim.o.smartcase = true

vim.o.signcolumn = 'yes'

vim.o.updatetime = 250

vim.o.timeoutlen = 300

vim.o.splitright = true
vim.o.splitbelow = true

vim.o.list = true
vim.opt.listchars = { trail = '·', nbsp = '␣', tab = '  ' }

vim.o.messagesopt = 'wait:4000,history:500'

vim.o.inccommand = 'split'

vim.o.cursorline = true

vim.o.scrolloff = 30

vim.o.wrap = false

vim.o.laststatus = 0

vim.o.winborder = 'rounded'

vim.o.cmdheight = 0

vim.o.spell = false
vim.o.spelllang = 'en'
vim.o.spellfile = vim.fn.stdpath 'config' .. '/spell/en.utf-8.add'

-- render-markdown.nvim needs concealment on to hide the markup it replaces.
vim.o.conceallevel = 1
