return {
  {
    'epwalsh/obsidian.nvim',
    version = '*', -- recommended, use latest release instead of latest commit
    lazy = true,
    ft = 'markdown',
    dependencies = {
      -- Required.
      'nvim-lua/plenary.nvim',
    },
    opts = {
      workspaces = {
        {
          name = 'obsidian',
          path = '~/vaults/obsidian',
        },
      },

      -- Add a custom frontmatter function
      note_frontmatter_func = function(note)
        -- Get the current datetime in ISO 8601 format
        local datetime = os.date '!%Y-%m-%dT%H:%M:%SZ' -- UTC time

        -- Create the base frontmatter
        local out = {
          id = note.id,
          tags = note.tags,
          updated_at = datetime,
        }

        -- Add tags based on the folder structure of the note's path
        if next(note.tags) == nil then
          -- Resolve the actual paths to handle symlinks
          local vault_path = vim.loop.fs_realpath(vim.fn.expand '~/vaults/obsidian') -- Real path of the vault
          local note_path = vim.loop.fs_realpath(vim.fn.expand '%:p') -- Real path of the note

          if not vault_path or not note_path then
            -- Fallback: If the realpath fails for some reason, skip adding tags
            return out
          end

          -- Remove the vault path from the note path
          local relative_path = note_path:sub(#vault_path + 2) -- +2 to remove trailing slash

          -- Extract folder names from the relative path and add them as tags
          for folder in string.gmatch(relative_path, '([^/]+)/') do
            table.insert(out.tags, folder)
          end

          -- other init metadata
          out.urls = {}
          out.snippet = false
        end

        -- `note.metadata` contains any manually added fields in the frontmatter.
        -- So here we just make sure those fields are kept in the frontmatter.
        if note.metadata ~= nil and not vim.tbl_isempty(note.metadata) then
          for k, v in pairs(note.metadata) do
            out[k] = v
          end
        end

        return out
      end,
    },
  },
  {
    'MeanderingProgrammer/render-markdown.nvim',
    ft = { 'markdown', 'codecompanion' },
  },
}
