-- Clear search highlights
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Split screen
vim.keymap.set('n', '<leader>-', ':split<CR>', { desc = 'Horizontal Split' })
vim.keymap.set('n', '<leader>|', ':vsplit<CR>', { desc = 'Vertical Split' })

-- Delete/change without yanking
vim.keymap.set('n', 'd', '"_d', { desc = 'Delete without yanking' })
vim.keymap.set('n', 'c', '"_c', { desc = 'Change without yanking' })

-- Paste without replacing clipboard
vim.keymap.set('v', '<leader>p', '"_dP', { desc = 'Paste without replacing clipboard' })

-- Diffview toggle
local function toggle_diffview()
  local view = require('diffview.lib').get_current_view()
  if view then
    vim.cmd 'DiffviewClose'
  else
    vim.cmd 'DiffviewOpen'
  end
end

vim.keymap.set('n', '<leader>gd', toggle_diffview, { desc = '[G]it [D]iff Toggle' })
vim.keymap.set('n', '<leader>gc', ':DiffviewOpen ', { desc = '[G]it [C]ompare selection' })

-- Toggle diagnostics location list
vim.keymap.set('n', '<leader>tt', function()
  if vim.fn.getloclist(0, { winid = 0 }).winid ~= 0 then
    vim.cmd 'lclose'
  else
    vim.diagnostic.setloclist()
    vim.cmd 'lopen'
  end
end, { desc = '[T]oggle [T]rouble' })

-- Auto-close location list on selection
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'qf',
  callback = function() vim.keymap.set('n', '<CR>', '<CR>:lclose<CR>', { buffer = true, silent = true }) end,
})

-- Search Obsidian notes in right split
local actions = require 'telescope.actions'
local action_state = require 'telescope.actions.state'

vim.keymap.set('n', '<leader>on', function()
  require('telescope.builtin').find_files {
    cwd = vim.fn.expand '~/vaults/obsidian',
    hidden = false,
    attach_mappings = function(prompt_bufnr, map)
      local open_in_right_split = function()
        local entry = action_state.get_selected_entry()
        actions.close(prompt_bufnr)
        vim.cmd 'vsplit'
        vim.cmd('edit ' .. entry.path)

         -- Move to end of frontmatter
        vim.api.nvim_buf_call(0, function()
          local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
          local first_dash_idx = nil
          local second_dash_idx = nil

          for i, line in ipairs(lines) do
            if line:match '^---' then
              if not first_dash_idx then
                first_dash_idx = i
              elseif not second_dash_idx then
                second_dash_idx = i
                break
              end
            end
          end

          if second_dash_idx then vim.api.nvim_win_set_cursor(0, { second_dash_idx + 2, 0 }) end
        end)
      end

      -- Open in right split on Enter
      map('i', '<CR>', open_in_right_split)
      map('n', '<CR>', open_in_right_split)
      return true
    end,
  }
end, { desc = '[O]bsidian [N]otes in a new pane' })
