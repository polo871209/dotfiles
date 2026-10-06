local GIT_TIMEOUT_MS = 2000
local GH_TIMEOUT_MS = 8000

---@param args string[]
---@param cwd string
---@return string? stdout trimmed, nil when git exits non-zero
local function git(args, cwd)
    local cmd = { 'git' }
    vim.list_extend(cmd, args)
    local res = vim.system(cmd, { cwd = cwd, text = true, timeout = GIT_TIMEOUT_MS }):wait()
    if res.code ~= 0 then return nil end
    return vim.trim(res.stdout or '')
end

local remote_patterns = {
    { '^git@github%.com%-[^:]+:(.+)%.git$', 'https://github.com/%1' },
    { '^git@github%.com%-[^:]+:(.+)$', 'https://github.com/%1' },
    { '^(https?://.*)%.git$', '%1' },
    { '^git@(.+):(.+)%.git$', 'https://%1/%2' },
    { '%.git$', '' },
}

---@param remote string
---@return string
local function to_https(remote)
    for _, pat in ipairs(remote_patterns) do
        local out, n = remote:gsub(pat[1], pat[2])
        if n > 0 then return out end
    end
    return remote
end

-- GitHub anchors a range as #L1-L9 under /blob/; GitLab uses #L1-9 under
-- /-/blob/. Keyed by host so a new forge is a table entry, not a branch.
local forges = {
    default = { blob = '/blob/%s/%s', range = '#L%d-L%d' },
    ['gitlab.com'] = { blob = '/-/blob/%s/%s', range = '#L%d-%d' },
}

---@class GitBlobRef
---@field base string browsable https root of the repository
---@field ref string branch name, or a SHA on detached HEAD
---@field path string repository-relative and URL-escaped
---@field first integer
---@field last integer

---@param loc GitBlobRef
---@return string
local function forge_url(loc)
    local forge = forges[loc.base:match '^https?://([^/]+)'] or forges.default
    local url = loc.base .. forge.blob:format(loc.ref, loc.path)
    if loc.first == loc.last then return ('%s#L%d'):format(url, loc.first) end
    return url .. forge.range:format(loc.first, loc.last)
end

---@return integer, integer
local function line_range()
    local mode = vim.fn.mode()
    if mode == 'v' or mode == 'V' or mode == '\22' then
        local first = vim.fn.getpos('v')[2]
        local last = vim.api.nvim_win_get_cursor(0)[1]
        if first > last then
            first, last = last, first
        end
        return first, last
    end
    local line = vim.api.nvim_win_get_cursor(0)[1]
    return line, line
end

local function browse()
    local file = vim.api.nvim_buf_get_name(0)
    local has_file = file ~= '' and vim.uv.fs_stat(file) ~= nil
    local dir = has_file and vim.fs.dirname(file) or (vim.uv.cwd() or vim.fn.getcwd())

    local root = git({ 'rev-parse', '--show-toplevel' }, dir)
    if not root then
        vim.notify('Not inside a git repository', vim.log.levels.WARN)
        return
    end

    local branch = git({ 'branch', '--show-current' }, root)

    local remote = git({ 'config', '--get', 'branch.' .. (branch or '') .. '.remote' }, root)
    local url = remote and git({ 'remote', 'get-url', remote }, root) or git({ 'remote', 'get-url', 'origin' }, root)
    if not url then
        vim.notify('No git remote configured', vim.log.levels.WARN)
        return
    end
    local base = to_https(url)

    local ref = (branch and branch ~= '') and branch or git({ 'rev-parse', 'HEAD' }, root)
    if not ref then
        vim.notify('Could not resolve a git ref', vim.log.levels.WARN)
        return
    end

    if not has_file then
        vim.ui.open(base)
        return
    end

    local rel = vim.fs.relpath(root, vim.uv.fs_realpath(file) or file)
    if not rel then
        vim.ui.open(base)
        return
    end
    rel = rel:gsub(' ', '%%20')

    local first, last = line_range()
    vim.ui.open(forge_url { base = base, ref = ref, path = rel, first = first, last = last })
end

---@return string?
local function repo_root()
    local file = vim.api.nvim_buf_get_name(0)
    local dir = (file ~= '' and vim.uv.fs_stat(file)) and vim.fs.dirname(file) or (vim.uv.cwd() or vim.fn.getcwd())
    return git({ 'rev-parse', '--show-toplevel' }, dir)
end

---@param lines string[]
---@param title string
local function open_float(lines, title)
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.bo[buf].filetype = 'git'
    vim.bo[buf].bufhidden = 'wipe'

    local width = math.floor(vim.o.columns * 0.6)
    local height = math.floor(vim.o.lines * 0.6)
    local win = vim.api.nvim_open_win(buf, true, {
        relative = 'editor',
        width = width,
        height = height,
        row = math.floor((vim.o.lines - height) / 2),
        col = math.floor((vim.o.columns - width) / 2),
        border = 'rounded',
        title = title,
        title_pos = 'center',
    })
    vim.wo[win].wrap = false
    vim.wo[win].number = false
    vim.wo[win].relativenumber = false
    vim.wo[win].signcolumn = 'no'

    for _, key in ipairs { 'q', '<Esc>' } do
        vim.keymap.set('n', key, function()
            if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_close(win, true) end
        end, { buffer = buf, nowait = true, desc = 'Close' })
    end
end

local BLAME_COUNT = 5

local function blame_line()
    local file = vim.api.nvim_buf_get_name(0)
    if file == '' or not vim.uv.fs_stat(file) then
        vim.notify('Buffer is not a file on disk', vim.log.levels.WARN)
        return
    end
    local root = repo_root()
    if not root then
        vim.notify('Not inside a git repository', vim.log.levels.WARN)
        return
    end
    local rel = vim.fs.relpath(root, vim.uv.fs_realpath(file) or file)
    if not rel then
        vim.notify('File is outside the repository', vim.log.levels.WARN)
        return
    end

    local lnum = vim.api.nvim_win_get_cursor(0)[1]
    local res = vim.system({
        'git',
        '-C',
        root,
        'log',
        '-n',
        tostring(BLAME_COUNT),
        '-u',
        '-L',
        ('%d,+1:%s'):format(lnum, rel),
    }, { text = true, timeout = GIT_TIMEOUT_MS }):wait()

    if res.code ~= 0 then
        local err = vim.trim(res.stderr or '')
        if err:match 'no path' or err:match 'no such path' then
            vim.notify(('%s is not tracked by git yet'):format(rel), vim.log.levels.INFO)
        elseif err:match 'has only %d+ lines' then
            vim.notify('Line is newer than the last commit', vim.log.levels.INFO)
        else
            vim.notify(err ~= '' and err or 'git log failed', vim.log.levels.WARN)
        end
        return
    end

    local out = vim.trim(res.stdout or '')
    if out == '' then
        vim.notify('No commit touches this line yet', vim.log.levels.INFO)
        return
    end
    open_float(vim.split(out, '\n'), (' Git Blame  %s:%d '):format(vim.fs.basename(rel), lnum))
end

vim.keymap.set({ 'n', 'x' }, '<leader>gB', browse, { desc = '[G]it [B]rowse' })
vim.keymap.set('n', '<leader>gb', blame_line, { desc = '[G]it [B]lame Line' })
local function pr_view()
    local root = repo_root()
    if not root then
        vim.notify('Not inside a git repository', vim.log.levels.WARN)
        return
    end
    local res = vim.system({ 'gh', 'pr', 'view', '--json', 'url', '-q', '.url' }, { cwd = root, text = true, timeout = GH_TIMEOUT_MS }):wait()
    local url = vim.trim(res.stdout or '')
    if res.code ~= 0 or url == '' then
        local msg = vim.trim(res.stderr or '')
        vim.notify(msg ~= '' and msg or ('gh pr view timed out after %ds'):format(GH_TIMEOUT_MS / 1000), vim.log.levels.WARN)
        return
    end
    vim.ui.open(url)
end

vim.keymap.set('n', '<leader>gP', pr_view, { desc = '[G]it [P]R view' })
