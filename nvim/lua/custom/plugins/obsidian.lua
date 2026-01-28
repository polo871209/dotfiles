return {
  {
    'epwalsh/obsidian.nvim',
    version = '*',
    lazy = true,
    ft = 'markdown',
    dependencies = {
      'nvim-lua/plenary.nvim',
    },
    opts = {
      workspaces = {
        {
          name = 'obsidian',
          path = '~/vaults/obsidian',
        },
      },

      -- Custom frontmatter
      note_frontmatter_func = function(note)
        -- Get current datetime
        local datetime = os.date '!%Y-%m-%dT%H:%M:%SZ'

        -- Create base frontmatter
        local out = {
          id = note.id,
          tags = note.tags,
          updated_at = datetime,
        }

        -- Add tags based on the folder structure of the note's path
        if next(note.tags) == nil then
          -- Resolve the actual paths to handle symlinks
          local vault_path = vim.uv.fs_realpath(vim.fn.expand '~/vaults/obsidian')
          local note_path = vim.uv.fs_realpath(vim.fn.expand '%:p')

          if not vault_path or not note_path then
            -- Fallback if realpath fails
            return out
          end

          -- Remove vault path from note path
          local relative_path = note_path:sub(#vault_path + 2)

          -- Add folder names as tags
          for folder in string.gmatch(relative_path, '([^/]+)/') do
            table.insert(out.tags, folder)
          end

          -- Init metadata
          out.urls = {}
          out.snippet = false
        end

        -- Keep manually added frontmatter fields
        if note.metadata ~= nil and not vim.tbl_isempty(note.metadata) then
          for k, v in pairs(note.metadata) do
            out[k] = v
          end
        end

        return out
      end,
    },
  },
}
