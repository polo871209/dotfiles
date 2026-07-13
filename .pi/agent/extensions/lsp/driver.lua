-- pi-lsp driver — loaded once into the persistent --embed nvim that lsp/
-- owns. Exposes _G.PiLsp = { hover, definition, references, status } for the
-- navigation tools. Caches one buffer per file (mtime-invalidated) so repeat
-- queries are warm.

local M = {}
_G.PiLsp = M

local ATTACH_TIMEOUT_MS = 2500
local REQ_TIMEOUT_MS = 5000
-- Cap on waiting for initial project indexing (vtsls/gopls/rust-analyzer
-- emit `$/progress` while building their index; cross-file results are
-- partial until that finishes). Warm calls skip this since the counter is 0.
local PROGRESS_TIMEOUT_MS = 8000

-- file (absolute) → bufnr. Reused so repeat queries don't re-:edit.
local bufs = {}
-- file → mtime (ns). Reload buffer if disk newer.
local mtimes = {}

-- Track in-flight WorkDoneProgress tokens via the LspProgress autocmd
-- (nvim 0.10+). When all begin tokens have matching end events, the server
-- is idle and cross-file queries are safe to send.
local in_flight = 0
local seen_tokens = {}
vim.api.nvim_create_autocmd('LspProgress', {
    group = vim.api.nvim_create_augroup('PiLspProgress', { clear = true }),
    callback = function(args)
        local params = args.data and args.data.params
        if not params or not params.value then return end
        local kind = params.value.kind
        local token = tostring(params.token)
        if kind == 'begin' and not seen_tokens[token] then
            seen_tokens[token] = true
            in_flight = in_flight + 1
        elseif kind == 'end' and seen_tokens[token] then
            seen_tokens[token] = nil
            in_flight = math.max(0, in_flight - 1)
        end
    end,
})

local function wait_progress_done(timeout_ms)
    if in_flight == 0 then return end
    vim.wait(timeout_ms, function() return in_flight == 0 end, 50)
end

local function file_mtime(file)
    local st = vim.uv.fs_stat(file)
    return st and st.mtime and (st.mtime.sec * 1e9 + st.mtime.nsec) or 0
end

local function open_buf(file)
    local existing = bufs[file]
    local current_mtime = file_mtime(file)
    if existing and vim.api.nvim_buf_is_valid(existing) and mtimes[file] == current_mtime then return existing end
    vim.cmd('silent! edit ' .. vim.fn.fnameescape(file))
    local b = vim.api.nvim_get_current_buf()
    bufs[file] = b
    mtimes[file] = current_mtime
    -- Force ft detection + autocmds so vim.lsp.enable() triggers attach.
    pcall(function() vim.cmd 'filetype detect' end)
    pcall(function() vim.cmd 'doautocmd BufRead' end)
    pcall(function() vim.cmd 'doautocmd FileType' end)
    -- Wait for LSP attach (best-effort).
    vim.wait(ATTACH_TIMEOUT_MS, function() return #vim.lsp.get_clients { bufnr = b } > 0 end, 50)
    -- Then wait for any initial project indexing to finish so cross-file
    -- queries (references, definition) return complete results on first try.
    wait_progress_done(PROGRESS_TIMEOUT_MS)
    return b
end

local function find_col(bufnr, line_1idx, symbol)
    if not symbol or symbol == '' then
        local line = vim.api.nvim_buf_get_lines(bufnr, line_1idx - 1, line_1idx, false)[1] or ''
        local s = line:find '%S'
        return s and (s - 1) or 0
    end
    local line = vim.api.nvim_buf_get_lines(bufnr, line_1idx - 1, line_1idx, false)[1] or ''
    local s = line:find(symbol, 1, true)
    if not s then s = line:lower():find(symbol:lower(), 1, true) end
    return s and (s - 1) or 0
end

local function make_position_params(bufnr, line_1idx, symbol)
    -- Brief wait if LSP not yet attached (cold buffer can race the request).
    if #vim.lsp.get_clients { bufnr = bufnr } == 0 then vim.wait(1500, function() return #vim.lsp.get_clients { bufnr = bufnr } > 0 end, 50) end
    local clients = vim.lsp.get_clients { bufnr = bufnr }
    if #clients == 0 then return nil, 'no LSP attached' end
    local col = find_col(bufnr, line_1idx, symbol)
    return {
        textDocument = vim.lsp.util.make_text_document_params(bufnr),
        position = { line = line_1idx - 1, character = col },
    }
end

local function uri_to_path(uri) return vim.uri_to_fname(uri) end

local function range_start(range)
    local s = range.start
    return (s.line or 0) + 1, (s.character or 0) + 1
end

local function read_line(file, line_1idx)
    local f = io.open(file, 'r')
    if not f then return '' end
    local i = 0
    for l in f:lines() do
        i = i + 1
        if i == line_1idx then
            f:close()
            return l:gsub('^%s+', '')
        end
    end
    f:close()
    return ''
end

function M.hover(file, line, symbol)
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/hover', params, REQ_TIMEOUT_MS)
    if not ok or not res then return { ok = false, error = 'request failed' } end
    for _, r in pairs(res) do
        local c = r.result and r.result.contents
        if c then
            if type(c) == 'string' then return { ok = true, text = c } end
            if c.value then return { ok = true, text = c.value } end
            if vim.islist(c) then
                local parts = {}
                for _, item in ipairs(c) do
                    if type(item) == 'string' then
                        table.insert(parts, item)
                    elseif type(item) == 'table' and item.value then
                        table.insert(parts, item.value)
                    end
                end
                if #parts > 0 then return { ok = true, text = table.concat(parts, '\n\n') } end
            end
        end
    end
    return { ok = true, text = '' }
end

local function normalize_locations(res)
    local out = {}
    for _, r in pairs(res or {}) do
        local result = r.result
        if result then
            if not vim.islist(result) then result = { result } end
            for _, loc in ipairs(result) do
                -- LocationLink → Location
                local uri = loc.uri or loc.targetUri
                local range = loc.range or loc.targetSelectionRange or loc.targetRange
                if uri and range then
                    local file = uri_to_path(uri)
                    local line, col = range_start(range)
                    table.insert(out, { file = file, line = line, col = col, context = read_line(file, line) })
                end
            end
        end
    end
    return out
end

function M.definition(file, line, symbol)
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/definition', params, REQ_TIMEOUT_MS)
    if not ok then return { ok = false, error = 'request failed' } end
    return { ok = true, locations = normalize_locations(res) }
end

function M.references(file, line, symbol)
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    params.context = { includeDeclaration = true }
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/references', params, REQ_TIMEOUT_MS)
    if not ok then return { ok = false, error = 'request failed' } end
    local locations = normalize_locations(res)
    -- vtsls (and similar lazy-loading TS servers) discover files on demand;
    -- a first references call returns only the declaration but primes the
    -- project model. If we got <= 1 hit, retry once — the second call sees
    -- the newly discovered files.
    if #locations <= 1 then
        wait_progress_done(2000)
        local ok2, res2 = pcall(vim.lsp.buf_request_sync, b, 'textDocument/references', params, REQ_TIMEOUT_MS)
        if ok2 then locations = normalize_locations(res2) end
    end
    return { ok = true, locations = locations }
end

local function changed_uris(workspace_edit)
    local uris = {}
    if workspace_edit.documentChanges then
        for _, change in ipairs(workspace_edit.documentChanges) do
            -- skip create/rename/delete file ops (no textDocument.edits)
            if change.textDocument and change.textDocument.uri then uris[change.textDocument.uri] = true end
        end
    elseif workspace_edit.changes then
        for uri, _ in pairs(workspace_edit.changes) do
            uris[uri] = true
        end
    end
    return uris
end

function M.rename(file, line, symbol, new_name)
    if not new_name or new_name == '' then return { ok = false, error = 'new_name required' } end
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    local supported = false
    for _, c in ipairs(vim.lsp.get_clients { bufnr = b }) do
        if c.server_capabilities and c.server_capabilities.renameProvider then
            supported = true
            break
        end
    end
    if not supported then return { ok = false, error = 'no attached LSP supports rename' } end
    params.newName = new_name
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/rename', params, REQ_TIMEOUT_MS)
    if not ok or not res then return { ok = false, error = 'request failed' } end
    local workspace_edit, enc
    for cid, r in pairs(res) do
        if r.result then
            workspace_edit = r.result
            local c = vim.lsp.get_client_by_id(cid)
            enc = c and c.offset_encoding or 'utf-16'
            break
        end
    end
    if not workspace_edit then return { ok = false, error = 'no rename edits returned (symbol not renameable here?)' } end
    local uris = changed_uris(workspace_edit)
    local apply_ok, apply_err = pcall(vim.lsp.util.apply_workspace_edit, workspace_edit, enc)
    if not apply_ok then return { ok = false, error = 'apply failed: ' .. tostring(apply_err) } end
    local written = {}
    for uri, _ in pairs(uris) do
        local bn = vim.uri_to_bufnr(uri)
        if vim.api.nvim_buf_is_valid(bn) then vim.api.nvim_buf_call(bn, function() vim.cmd 'silent! write!' end) end
        -- invalidate nav cache so subsequent queries reload from disk
        local f = uri_to_path(uri)
        bufs[f] = nil
        mtimes[f] = nil
        table.insert(written, f)
    end
    table.sort(written)
    return { ok = true, files = written, count = #written }
end

function M.status()
    local files = {}
    for f, b in pairs(bufs) do
        if vim.api.nvim_buf_is_valid(b) then
            local clients = vim.tbl_map(function(c) return c.name end, vim.lsp.get_clients { bufnr = b })
            table.insert(files, { file = f, bufnr = b, clients = clients })
        end
    end
    return { ok = true, files = files }
end

-- Driver loaded for side-effects (_G.PiLsp). Don't return functions —
-- msgpack can't serialize them.
return true
