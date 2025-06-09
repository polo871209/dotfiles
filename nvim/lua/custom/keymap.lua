-- [[ Basic Keymaps ]]
--  See `:help vim.keymap.set()`

-- Clear highlights on search when pressing <Esc> in normal mode
--  See `:help hlsearch`
vim.keymap.set('n', '<Esc>', '<cmd>nohlsearch<CR>')

-- Diagnostic keymaps
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostic [Q]uickfix list' })

-- Show LSP documentation on hover
vim.keymap.set('n', '<leader>d', vim.lsp.buf.hover, { desc = 'Show [D]ocumentation (Hover)' })

-- Spilt screen
vim.api.nvim_set_keymap('n', '<leader>-', ':split<CR>', { noremap = true, silent = true })
vim.api.nvim_set_keymap('n', '<leader>|', ':vsplit<CR>', { noremap = true, silent = true })

-- Disable copy when delete
vim.api.nvim_set_keymap('n', 'd', '"_d', { noremap = true, silent = true })
vim.api.nvim_set_keymap('v', 'd', '"_d', { noremap = true, silent = true })
vim.api.nvim_set_keymap('n', 'c', '"_c', { noremap = true, silent = true })

-- Telescope
-- See `:help telescope.builtin`
local builtin = require 'telescope.builtin'
vim.keymap.set('n', '<leader><leader>', builtin.find_files, { desc = '[ ] Find Files' })
vim.keymap.set('n', '<leader>/', builtin.current_buffer_fuzzy_find, { desc = '[/] Fuzzily search in current buffer' })
vim.keymap.set('n', '<leader>s.', builtin.oldfiles, { desc = '[S]earch Recent Files ("." for repeat)' })
vim.keymap.set('n', '<leader>sb', builtin.buffers, { desc = '[S]earch [B]uffer' })
vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
vim.keymap.set('n', '<leader>sg', builtin.live_grep, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sk', builtin.keymaps, { desc = '[S]earch [K]eymaps' })
vim.keymap.set('n', '<leader>ss', builtin.spell_suggest, { desc = '[S]pell [S]uggestion' })
vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })

-- CodeCompanion: AI-powered pair programmer for Neovim
vim.keymap.set('n', '<leader>aa', '<cmd>CodeCompanionChat Toggle<CR>', { desc = 'CodeCompanion Toggle' })
vim.keymap.set('v', '<leader>aa', ':CodeCompanion ', { desc = 'CodeCompanion Inline' })
vim.keymap.set('v', '<leader>aw', '<cmd>CodeCompanion /word<CR>', { desc = 'CodeCompanion Inline [W]ord' })
vim.keymap.set('n', '<leader>ac', '<cmd>CodeCompanionActions<CR>', { desc = 'CodeCompanion Action [C]enter' })
vim.keymap.set('n', '<leader>ah', '<cmd>CodeCompanionHistory<CR>', { desc = 'CodeCompanion [H]istory' })
vim.keymap.set('v', '<leader>al', '<cmd>CodeCompanionChat Add<CR>', { desc = 'CodeCompanion add [Lines] to buffer' })
vim.keymap.set('n', '<leader>an', '<cmd>CodeCompanionChat<CR>', { desc = 'CodeCompanion [N]ew Chat' })

-- It's also possible to pass additional configuration options.
--  See `:help telescope.builtin.live_grep()` for information about particular keys
vim.keymap.set('n', '<leader>s/', function()
  builtin.live_grep {
    grep_open_files = true,
    prompt_title = 'Live Grep in Open Files',
  }
end, { desc = '[S]earch [/] in Open Files' })

-- Searching your Neovim configuration files
vim.keymap.set('n', '<leader>sn', function()
  builtin.find_files { cwd = vim.fn.stdpath 'config' }
end, { desc = '[S]earch [N]eovim files' })

-- Search Obsidian notes and open selected file in a right split
local actions = require 'telescope.actions'
local action_state = require 'telescope.actions.state'

vim.keymap.set('n', '<leader>on', function()
  require('telescope.builtin').find_files {
    cwd = vim.fn.expand '~/vaults/obsidian',
    hidden = false,
    attach_mappings = function(prompt_bufnr, map)
      local open_in_right_split = function()
        local entry = action_state.get_selected_entry()
        actions.close(prompt_bufnr) -- Close Telescope
        vim.cmd 'vsplit' -- Open in a vertical split
        vim.cmd('edit ' .. entry.path) -- Open the selected file

        -- Move the cursor to the second appearance of ---
        vim.api.nvim_buf_call(0, function()
          local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false) -- Get the buffer lines
          local first_dash_idx = nil
          local second_dash_idx = nil

          -- Find the indices of the first and second appearance of ---
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

          -- Move the cursor to the second appearance of ---
          if second_dash_idx then
            vim.api.nvim_win_set_cursor(0, { second_dash_idx + 2, 0 })
          end
        end)
      end

      -- Map `<CR>` (Enter) to open in a right split
      map('i', '<CR>', open_in_right_split)
      map('n', '<CR>', open_in_right_split)
      return true
    end,
  }
end, { desc = '[O]bsidian [N]otes in a new pane' })
