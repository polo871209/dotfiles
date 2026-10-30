if vim.g.pi_agent then return end

local group = vim.api.nvim_create_augroup('image-lazy', { clear = true })

local function load()
    vim.api.nvim_del_augroup_by_id(group)
    vim.pack.add { 'https://github.com/3rd/image.nvim' }
    require('image').setup {}
end

vim.api.nvim_create_autocmd('FileType', {
    group = group,
    pattern = { 'markdown', 'vimwiki', 'asciidoc', 'norg', 'typst', 'syslang' },
    callback = load,
})
vim.api.nvim_create_autocmd('BufReadPre', {
    group = group,
    pattern = { '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif' },
    callback = load,
})
