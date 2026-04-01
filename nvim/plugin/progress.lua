-- Ghostty supports OSC 9;4 natively for progress bars.
-- Outside tmux, Neovim's default handler (nvim.progress) sends it via nvim_ui_send directly.
-- Inside tmux, the raw OSC 9;4 is dropped by tmux, so re-send it wrapped in DCS passthrough
-- via nvim_ui_send — tmux's allow-passthrough then forwards it to Ghostty.
-- Handles all progress sources: 'lsp', 'vim.pack', etc.
if vim.env.TMUX then
  vim.api.nvim_create_autocmd('Progress', {
    group = vim.api.nvim_create_augroup('nvim-tmux-osc', { clear = true }),
    callback = function(ev)
      local d = ev.data
      -- state: 0=hidden, 1=running+percent, 2=error, 3=indeterminate, 4=warning
      local done = d.status == 'success' or d.status == 'error'
      local state = done and 0 or (d.percent and 1 or 3)
      local pct = d.percent or 0
      vim.api.nvim_ui_send(string.format('\027Ptmux;\027\027]9;4;%d;%d\007\027\\', state, pct))
    end,
  })
end
