if vim.g.pi_agent then return end

local group = vim.api.nvim_create_augroup('autoreload', { clear = true })

vim.api.nvim_create_autocmd('FileChangedShell', {
    desc = 'Reload files changed on disk, even with unsaved edits',
    group = group,
    callback = function(args)
        local reason = vim.v.fcs_reason
        if reason ~= 'changed' and reason ~= 'conflict' then return end
        vim.v.fcs_choice = 'reload'
        if reason == 'conflict' then
            local name = vim.fn.fnamemodify(args.file, ':~:.')
            vim.schedule(function() vim.notify(('Reloaded %s over unsaved edits, press u to restore them'):format(name), vim.log.levels.WARN) end)
        end
    end,
})

vim.uv.new_timer():start(
    1000,
    1000,
    vim.schedule_wrap(function()
        if vim.api.nvim_get_mode().mode == 'n' and vim.fn.getcmdwintype() == '' then vim.cmd.checktime() end
    end)
)
