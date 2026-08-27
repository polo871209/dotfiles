-- HTTP client for .http files. Agent nvim has no use for interactive requests.
if vim.g.pi_agent then return end

vim.pack.add { 'https://github.com/mistweaverco/kulala.nvim' }

-- Both the LSP and the parser attach through FileType autocmds created *inside*
-- setup(), i.e. too late for the event that triggered the load, so the event is
-- re-emitted for that buffer once they exist -- scoped to kulala's own groups so
-- no other FileType handler runs twice. On a cold first run the downloads are
-- still in flight and the LSP only attaches to the next http buffer.
local kulala_groups = { 'Kulala filetype setup', 'KulalaTreesitter' }
local ft_group = vim.api.nvim_create_augroup('kulala-lazy-setup', { clear = true })
local loaded = false

--- setup() downloads the kulala-core binary and git-clones/builds the
--- `kulala_http` tree-sitter parser (tree-sitter CLI comes from mise), so it is
--- deferred to the first http buffer or keymap press rather than paid at startup.
---@param buf integer? buffer whose FileType event is being served, if any
local function load(buf)
    if loaded then return end
    loaded = true
    pcall(vim.api.nvim_del_augroup_by_id, ft_group)

    require('kulala').setup {
        -- Default also covers javascript/typescript/lua for *.http.{js,ts,lua}
        -- scripts, which would run the ft hook on every such buffer.
        lsp = { filetypes = { 'http', 'rest' } },
        global_keymaps = {
            -- Entries given here are used verbatim: only kulala's own defaults
            -- get global_keymaps_prefix prepended.
            ['Send request'] = { '<leader>Rs', function() require('kulala_embed').run() end, mode = { 'n', 'v' } },
        },
        -- Merged per-name over the defaults, so replacing an entry also drops
        -- the key it used to own. The winbar reads the same table, so its
        -- "Verbose (V)" hint follows the remap.
        --
        -- Verbose moves to `v` to leave `V` free: the result buffer is a normal
        -- buffer and linewise visual select is how text gets yanked out of it.
        -- Tabs move off <C-h>/<C-l>, which shadowed the window+tmux pane
        -- navigation from plugin/keymap.lua.
        kulala_keymaps = {
            ['Show verbose'] = { 'v', function() require('kulala.ui').show_verbose() end },
            ['Next tab'] = { 'gt', function() require('kulala.ui').show_next_tab() end },
            ['Previous tab'] = { 'gT', function() require('kulala.ui').show_previous_tab() end },
        },
        -- Restoring needs eager loading plus 'sessionoptions' +=globals.
        session = { restore = false },
    }

    if not buf then return end
    for _, name in ipairs(kulala_groups) do
        pcall(vim.api.nvim_exec_autocmds, 'FileType', { buffer = buf, group = name })
    end
end

vim.api.nvim_create_autocmd('FileType', {
    group = ft_group,
    pattern = { 'http', 'rest' },
    callback = function(ev) load(ev.buf) end,
})

-- Kulala's own global keymaps only exist once setup() has run, but embedded
-- requests get sent from source buffers that can open with no .http file in
-- sight. These stubs load on first press; setup() then replaces them in place.
local stubs = {
    { 'Ra', 'Send all requests', function() require('kulala').run_all() end },
    { 'Rb', 'Open scratchpad', function() require('kulala').scratchpad() end },
    { 'Ro', 'Open kulala', function() require('kulala').open() end },
    { 'Rr', 'Replay the last request', function() require('kulala').replay() end },
    { 'Rs', 'Send request', function() require('kulala_embed').run() end },
}

for _, stub in ipairs(stubs) do
    local suffix, desc, run = stub[1], stub[2], stub[3]
    vim.keymap.set({ 'n', 'x' }, '<leader>' .. suffix, function()
        load()
        run()
    end, { desc = desc })
end
