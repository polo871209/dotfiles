if vim.g.pi_agent then return end

vim.pack.add {
    'https://github.com/folke/flash.nvim',
    'https://github.com/lewis6991/gitsigns.nvim',
}

vim.keymap.set('n', 's', function() require('flash').jump() end, { desc = 'Flash' })
vim.keymap.set('n', 'S', function() require('flash').treesitter() end, { desc = 'Flash Treesitter' })

require('gitsigns').setup {
    signs = {
        add = { text = '+' },
        change = { text = '~' },
        delete = { text = '_' },
        topdelete = { text = '‾' },
        changedelete = { text = '~' },
    },
}

-- Outside tmux, Neovim's default handler (nvim.progress) sends it via nvim_ui_send directly.
-- Inside tmux, the raw OSC 9;4 is dropped by tmux, so re-send it wrapped in DCS passthrough
-- via nvim_ui_send — tmux's allow-passthrough then forwards it to Ghostty.
if vim.env.TMUX then
    local osc_progress = { hidden = 0, percent = 1, indeterminate = 3 }
    vim.api.nvim_create_autocmd('Progress', {
        group = vim.api.nvim_create_augroup('nvim-tmux-osc', { clear = true }),
        callback = function(ev)
            local d = ev.data
            local done = d.status == 'success' or d.status == 'error'
            local state = done and osc_progress.hidden or (d.percent and osc_progress.percent or osc_progress.indeterminate)
            local pct = d.percent or 0
            vim.api.nvim_ui_send(string.format('\027Ptmux;\027\027]9;4;%d;%d\007\027\\', state, pct))
        end,
    })
end
