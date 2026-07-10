-- pi-lsp driver — loaded once into the persistent --embed nvim that lsp/
-- owns. Exposes _G.PiLsp = { hover, definition, references,
-- implementation, type_definition, document_symbols, diagnostics, status }
-- for the nav tools.
-- Caches one buffer per file (mtime-invalidated) so repeat queries are warm.

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

-- open_buf silently creates an empty scratch buffer for a missing path
-- (`:edit` doesn't error), which then surfaces as a confusing "no LSP
-- attached" instead of "file not found". Callers taking a single `file`
-- check this first.
local function file_exists(file) return vim.uv.fs_stat(file) ~= nil end

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
    if not file_exists(file) then return { ok = false, error = 'file not found: ' .. file } end
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
    if not file_exists(file) then return { ok = false, error = 'file not found: ' .. file } end
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/definition', params, REQ_TIMEOUT_MS)
    if not ok then return { ok = false, error = 'request failed' } end
    return { ok = true, locations = normalize_locations(res) }
end

function M.references(file, line, symbol)
    if not file_exists(file) then return { ok = false, error = 'file not found: ' .. file } end
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

-- Shared body for position → location-list methods (definition-shaped).
local function loc_request(file, line, symbol, method)
    if not file_exists(file) then return { ok = false, error = 'file not found: ' .. file } end
    local b = open_buf(file)
    local params, err = make_position_params(b, line, symbol)
    if not params then return { ok = false, error = err } end
    local ok, res = pcall(vim.lsp.buf_request_sync, b, method, params, REQ_TIMEOUT_MS)
    if not ok then return { ok = false, error = 'request failed' } end
    return { ok = true, locations = normalize_locations(res) }
end

function M.implementation(file, line, symbol) return loc_request(file, line, symbol, 'textDocument/implementation') end

function M.type_definition(file, line, symbol) return loc_request(file, line, symbol, 'textDocument/typeDefinition') end

-- LSP SymbolKind enum (1-indexed) → label.
local SYMBOL_KINDS = {
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum-member',
    'struct',
    'event',
    'operator',
    'type-param',
}

-- documentSymbol returns either hierarchical DocumentSymbol[] (has .children,
-- .selectionRange) or flat SymbolInformation[] (has .location). Flatten both
-- to a depth-tagged list.
local function flatten_doc_symbols(items, out, depth)
    for _, s in ipairs(items or {}) do
        local line, col = 0, 0
        if s.location then
            line, col = range_start(s.location.range)
        elseif s.selectionRange or s.range then
            line, col = range_start(s.selectionRange or s.range)
        end
        table.insert(out, {
            name = s.name,
            kind = SYMBOL_KINDS[s.kind] or tostring(s.kind),
            line = line,
            col = col,
            depth = depth,
            detail = s.detail and (s.detail:gsub('\r?\n', ' ')) or nil,
        })
        if s.children then flatten_doc_symbols(s.children, out, depth + 1) end
    end
end

function M.document_symbols(file)
    if not file_exists(file) then return { ok = false, error = 'file not found: ' .. file } end
    local b = open_buf(file)
    if #vim.lsp.get_clients { bufnr = b } == 0 then return { ok = false, error = 'no LSP attached' } end
    local params = { textDocument = vim.lsp.util.make_text_document_params(b) }
    local ok, res = pcall(vim.lsp.buf_request_sync, b, 'textDocument/documentSymbol', params, REQ_TIMEOUT_MS)
    if not ok or not res then return { ok = false, error = 'request failed' } end
    local out = {}
    for _, r in pairs(res) do
        if r.result then flatten_doc_symbols(r.result, out, 0) end
    end
    return { ok = true, symbols = out }
end

-- Shared lint/diagnostic helpers on _G.PiLspShared; feedback.lua (loaded after,
-- into the same nvim) reuses them instead of duplicating.
_G.PiLspShared = _G.PiLspShared or {}

-- Async/network linters (semgrep) leave orphan jobs in a sync pull; skip here.
_G.PiLspShared.SLOW_LINTERS = { semgrep = true }

function _G.PiLspShared.run_fast_lint(bufnr)
    local ok, lint = pcall(require, 'lint')
    if not ok then return end
    local names = lint.linters_by_ft[vim.bo[bufnr].filetype]
    if not names then return end
    local allowed = {}
    for _, name in ipairs(names) do
        if not _G.PiLspShared.SLOW_LINTERS[name] then table.insert(allowed, name) end
    end
    if #allowed == 0 then return end
    pcall(function() lint.try_lint(allowed) end)
end

-- timeout: max ms to wait for each server's pull response.
function _G.PiLspShared.pull_diagnostics(bufnr, timeout)
    for _, client in ipairs(vim.lsp.get_clients { bufnr = bufnr }) do
        local caps = client.server_capabilities or {}
        if caps.diagnosticProvider then
            local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
            pcall(vim.lsp.buf_request_sync, bufnr, 'textDocument/diagnostic', params, timeout)
        end
    end
end

-- Pull-only diagnostics for the given files. Unlike PiFeedback.run this never
-- formats, applies code-actions, or writes — read-only verification the agent
-- can call instead of a slow full `tsc`. Reuses the warm buffer cache.
function M.diagnostics(files)
    local sev = { 'error', 'warn', 'info', 'hint' }
    local out = { ok = true, diagnostics = {} }
    local opened = {}
    local seen = {}
    for _, file in ipairs(files) do
        -- Dedupe: a repeated path would otherwise open the same buffer twice
        -- and double-count its diagnostics below.
        if type(file) == 'string' and not seen[file] and vim.uv.fs_stat(file) then
            seen[file] = true
            local b = open_buf(file)
            table.insert(opened, b)
            _G.PiLspShared.pull_diagnostics(b, 1500)
            _G.PiLspShared.run_fast_lint(b)
        end
    end
    -- Servers push diagnostics async and lag; across files some report later.
    -- Wait until the total count stops growing, not just the first buffer, so
    -- multi-file calls don't drop stragglers. Settled once the count holds
    -- steady across two polls after the baseline read (works at zero too),
    -- so clean files don't burn the full cap.
    local function total_diags()
        local n = 0
        for _, b in ipairs(opened) do
            if vim.api.nvim_buf_is_valid(b) then n = n + #vim.diagnostic.get(b) end
        end
        return n
    end
    local last = -1
    local stable = 0
    vim.wait(3000, function()
        local n = total_diags()
        if n == last then
            stable = stable + 1
            if stable >= 2 then return true end
        else
            stable = 0
        end
        last = n
        return false
    end, 150)
    for _, bufnr in ipairs(opened) do
        if vim.api.nvim_buf_is_valid(bufnr) then
            for _, d in ipairs(vim.diagnostic.get(bufnr)) do
                table.insert(out.diagnostics, {
                    file = vim.api.nvim_buf_get_name(bufnr),
                    line = (d.lnum or 0) + 1,
                    col = (d.col or 0) + 1,
                    severity = sev[d.severity] or 'info',
                    source = d.source,
                    code = d.code and tostring(d.code) or nil,
                    message = (d.message or ''):gsub('\r?\n', ' '),
                })
            end
        end
    end
    return out
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
