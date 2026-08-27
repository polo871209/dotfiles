--- Runs HTTP requests written in source comments, so a route handler can carry
--- the request that exercises it instead of a parallel .http file.
---
--- Kulala can already do this when the request sits in a ``` fence anchored at
--- column 0, or on the single line under the cursor. Neither covers a request
--- spread over a `// ` comment run, and its visual-selection path passes lines
--- through verbatim (parser/document.lua `resolve_content_lines` only calls
--- `strip_invalid_chars` on the fence/current-line branch), so a selection of
--- commented lines parses as nothing but comments.
---
--- So the block is extracted, unindented, stripped of its comment markers and
--- run out of a scratch buffer. The scratch buffer is named next to the source
--- file, which is all kulala needs to keep resolving http-client.env.json and
--- friends from that directory (cmd/kulala_core_bridge.lua
--- `resolve_document_paths` falls back to the buffer name's parent).
---
--- On top of that it adds globals shared by every block (see `shared_lines`)
--- and puts kulala's own status inlay back on the comment (`mirror_status`),
--- which would otherwise be drawn on the invisible scratch buffer.

local M = {}

--- Innermost node at the first non-blank column of `lnum` able to hold a
--- request: a comment in any language, or a multi-line string used as a comment
--- block (Python docstrings, Lua `[[ ]]`). Ancestors are searched because a
--- docstring's delimiter is its own single-row token.
---@param lnum integer 1-indexed; out-of-range lines yield nil
---@return TSNode?
local function block_node(lnum)
    local col = vim.fn.getline(lnum):find '%S'
    if not col then return end

    -- `get_node` yields nil while the tree is unparsed, which is the state
    -- whenever highlighting has not run over the buffer. Cheap once valid.
    local parsed, parser = pcall(vim.treesitter.get_parser, 0)
    if not parsed or not parser then return end
    parser:parse()

    local ok, node = pcall(vim.treesitter.get_node, { pos = { lnum - 1, col - 1 } })
    if not ok then return end

    while node do
        local kind = node:type()
        if kind:find 'comment' then return node end
        if kind:find 'string' then
            local srow, _, erow = node:range()
            if erow > srow then return node end
        end
        node = node:parent()
    end
end

--- True when `lnum` holds a one-line comment, i.e. a block that grows by
--- absorbing its neighbours rather than one the parser already delimits.
---@param lnum integer
local function is_line_comment(lnum)
    local node = block_node(lnum)
    if not node or not node:type():find 'comment' then return false end
    local srow, _, erow, ecol = node:range()
    return erow == srow or (erow == srow + 1 and ecol == 0)
end

--- Bounds of the comment or block-string containing `lnum`, 1-indexed inclusive.
---@param lnum integer
---@return integer? first, integer? last
local function block_range(lnum)
    local node = block_node(lnum)
    if not node then return end

    local srow, _, erow, ecol = node:range()
    srow, erow = srow + 1, erow + 1
    -- Some grammars close a node on the following row at column 0.
    if erow > srow and ecol == 0 then erow = erow - 1 end

    if erow > srow then return srow, erow end

    while is_line_comment(srow - 1) do
        srow = srow - 1
    end
    while is_line_comment(erow + 1) do
        erow = erow + 1
    end

    return srow, erow
end

--- Lines that are pure delimiter noise once the comment markers are off: `"""`,
--- `/*`, `*/`, ```` ``` ````. Kulala's `###` separator and its `# @directive`s
--- are punctuation-only too, hence the explicit exemption.
---
--- Requires at least one punctuation character, so a blank line survives: a
--- commented-out blank (`#` on its own) strips to "", and that empty line is
--- what separates headers from the body.
---@param line string
local function is_delimiter(line)
    if line:match '^%s*###' or line:match '^%s*#%s*@' then return false end
    return line:match '^%s*%p+%s*$' ~= nil
end

--- A JetBrains start line: method plus target. Anchored on an all-caps word so
--- `GetUser returns one user.` does not read as a verb.
local START_LINE = '^%u[%u%d]*%s+%S'

--- True where a request starts: a start line, a kulala separator, directive or
--- `run`/`import` statement, or a variable assignment. Used to drop the prose a
--- doc comment opens with.
---@param line string
local function is_request_start(line)
    return line:match '^###' ~= nil
        or line:match '^#%s*@' ~= nil
        or line:match '^@[%w_-]+%s*=' ~= nil
        or line:match '^run%s' ~= nil
        or line:match '^import%s' ~= nil
        or line:match(START_LINE) ~= nil
end

--- A blank line still belongs to the block around it, but carries no node to
--- search from. Look up first, so the block just finished writing wins over the
--- one below.
---@param lnum integer
---@return integer
local function nearest_content(lnum)
    if vim.fn.getline(lnum):find '%S' then return lnum end
    for _, probe in ipairs { lnum - 1, lnum + 1 } do
        if vim.fn.getline(probe):find '%S' then return probe end
    end
    return lnum
end

--- Name of the per-project file holding globals shared by every comment block.
local SHARED = 'kulala.http'

--- Header for blocks the extraction has to supply itself. Named, not a bare
--- `###`: kulala-core hangs on an unnamed block that follows one carrying a
--- post-request script, which is exactly the shape an expanded `run #name`
--- produces. It also reads better than the generated `REQUEST_001`.
local HEADER = '### embedded'

--- The nearest `kulala.http` split into the preamble every comment block gets,
--- and its named blocks keyed by name.
---
--- The preamble is everything above the first `###`. Document-level `@vars`
--- there reach every request in the document; a `### Shared` block would not,
--- its variables never propagate (kulala-core 0.37).
---@param path string source file
---@return string[] preamble, table<string, string[]> blocks
local function shared_document(path)
    local found = vim.fs.find(SHARED, { upward = true, type = 'file', path = vim.fs.dirname(path) })[1]
    if not found then return {}, {} end

    local preamble, blocks, current = {}, {}, nil
    for _, line in ipairs(vim.fn.readfile(found)) do
        local name = line:match '^###%s*(.-)%s*$'
        if name then
            current = name
            blocks[current] = { line }
        elseif current then
            table.insert(blocks[current], line)
        else
            preamble[#preamble + 1] = line
        end
    end

    return preamble, blocks
end

--- Replace every `run #name` with the named block from `kulala.http`.
---
--- Inlining rather than leaning on kulala's own `import`/`run`: kulala-core will
--- not execute a `run` statement and a request of its own in one pass, and an
--- `import` line makes every request in the imported file fire once the document
--- is run whole. Inlined, the shared request is simply the first block in the
--- document, so it runs first and can hand values on via
--- `client.global.set` in a post-request script.
---@param lines string[]
---@param blocks table<string, string[]>
---@return string[] lines, boolean expanded
local function expand_runs(lines, blocks)
    local out, expanded = {}, false

    for i, line in ipairs(lines) do
        local name = line:match '^run%s+#%s*(.-)%s*$'
        local block = name and blocks[name]

        if not block then
            out[#out + 1] = line
        else
            expanded = true
            -- The block carries its own `### name` header.
            vim.list_extend(out, block)
            out[#out + 1] = ''

            -- Whatever follows is a separate request and needs its own header,
            -- unless it already opens one -- two headers in a row would leave an
            -- empty block between them.
            local opens_block
            for j = i + 1, #lines do
                if lines[j]:match '%S' then
                    opens_block = lines[j]:match '^###' ~= nil
                    break
                end
            end
            if opens_block == false then out[#out + 1] = HEADER end
        end
    end

    return out, expanded
end

--- Turn source lines `first`..`last` into a request, with `lnum` deciding which
--- request is targeted when the range holds several.
---@param first integer
---@param last integer
---@param lnum integer
---@param blocks table<string, string[]> named blocks from `kulala.http`
---@return string[]? lines, integer? anchor, integer? target, boolean? expanded
local function request_from(first, last, lnum, blocks)
    local raw = vim.api.nvim_buf_get_lines(0, first - 1, last, false)
    -- Kulala's own stripper: drops leading comment markers and indentation while
    -- preserving `###` and `# @` at the start of a line.
    local stripped = require('kulala.parser.utils').strip_invalid_chars(raw)

    -- Kept in step, so a kept line can be mapped back to where it came from.
    ---@type string[], integer[]
    local lines, source_lines = {}, {}
    for i, line in ipairs(stripped) do
        if not is_delimiter(line) then
            lines[#lines + 1] = line
            source_lines[#source_lines + 1] = first + i - 1
        end
    end

    local start = 1
    while start <= #lines and not is_request_start(lines[start]) do
        start = start + 1
    end
    -- A comment with no request in it: let the caller fall back to kulala.
    if start > #lines then return end

    lines = vim.list_slice(lines, start)
    source_lines = vim.list_slice(source_lines, start)

    -- Which extracted line the cursor sits on, so a block holding several
    -- requests sends the one being looked at.
    local target = 1
    for i, source in ipairs(source_lines) do
        if source <= lnum then target = i end
    end

    -- Hang the inlay off that request's method line rather than an `@var` or
    -- `# @directive` line, searching forward first so a cursor parked on a
    -- directive still resolves downwards to its own request.
    local anchor = source_lines[target]
    for i = target, #lines do
        if lines[i]:match(START_LINE) then
            anchor = source_lines[i]
            break
        end
    end

    local expanded
    lines, expanded = expand_runs(lines, blocks)

    -- kulala-core wants a block header, but only add one when the document has
    -- none of its own: prepending it would push leading `@var` assignments inside
    -- the first block instead of leaving them at document scope, where later
    -- blocks can still see them.
    local has_header = vim.iter(lines):any(function(line) return line:match '^###' ~= nil end)
    if not has_header then
        table.insert(lines, 1, HEADER)
        target = target + 1
    end

    return lines, anchor, target, expanded
end

--- The request in the comment or block-string under the cursor.
---@param lnum integer
---@param blocks table<string, string[]>
---@return string[]? lines, integer? anchor, integer? target, boolean? expanded
local function block_request(lnum, blocks)
    lnum = nearest_content(lnum)
    local first, last = block_range(lnum)
    if not first or not last then return end
    return request_from(first, last, lnum, blocks)
end

--- The request in the current linewise selection, which is left on exit.
---@param blocks table<string, string[]>
---@return string[]? lines, integer? anchor, integer? target, boolean? expanded
local function selection_request(blocks)
    local first, last = vim.fn.line 'v', vim.fn.line '.'
    if first > last then
        first, last = last, first
    end

    local lnum = vim.fn.line '.'
    vim.cmd.normal { vim.keycode '<Esc>', bang = true }

    return request_from(first, last, lnum, blocks)
end

---@type table<string, integer> source path -> scratch buffer
local scratch = {}

--- Hidden `http` buffer standing in for `path`, reused across runs so repeated
--- sends do not leak buffers or collide on the name.
---@param path string
---@return integer
local function scratch_buf(path)
    local name = vim.fs.joinpath(vim.fs.dirname(path), '.' .. vim.fs.basename(path) .. '.kulala.http')

    local buf = scratch[name]
    if buf and vim.api.nvim_buf_is_valid(buf) then return buf end

    buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(buf, name)
    vim.bo[buf].filetype = 'http'
    vim.bo[buf].buftype = 'nofile'
    vim.bo[buf].swapfile = false
    scratch[name] = buf

    return buf
end

local NS = vim.api.nvim_create_namespace 'kulala_inlay_hints'

--- Virtual-text chunks kulala is currently showing in `buf`, keeping the
--- highlight groups so the mirrored copy looks identical.
--- An expanded `run #name` runs several requests, so kulala leaves one mark per
--- request. Collapse them into the single state worth reporting: still waiting
--- beats a failure, and a failure beats a success.
---@param buf integer
---@param icons table<string, string>
---@return table[]? chunks, boolean? settled, boolean? failed
local function inlay_chunks(buf, icons)
    if not vim.api.nvim_buf_is_valid(buf) then return end

    local loading, failed, done
    for _, mark in ipairs(vim.api.nvim_buf_get_extmarks(buf, NS, 0, -1, { details = true })) do
        local chunks = mark[4] and mark[4].virt_text
        if chunks then
            local text = table.concat(vim.tbl_map(function(chunk) return chunk[1] end, chunks))
            if icons.error and text:find(icons.error, 1, true) then
                failed = failed or chunks
            elseif icons.done and text:find(icons.done, 1, true) then
                done = chunks -- last one wins, so the duration shown is the whole run
            else
                loading = loading or chunks
            end
        end
    end

    if loading then return loading, false end
    if failed then return failed, true, true end
    if done then return done, true end
end

---@type uv.uv_timer_t?
local mirror

local function stop_mirror()
    if not mirror then return end
    mirror:stop()
    if not mirror:is_closing() then mirror:close() end
    mirror = nil
end

--- Run `targets` (line numbers in the scratch document) one at a time, copying
--- kulala's status onto `line` of `source` as it goes.
---
--- One at a time rather than one whole-document run: kulala-core 0.37 hangs on a
--- document run whole when it holds more than one request. That reproduces with
--- kulala's own `run_all` on a hand-written .http file, so it is not something
--- this module can dodge by assembling the document differently.
---
--- The status is polled rather than driven by the `after_request` event, which
--- never fires when a request fails before leaving the machine (a DNS failure,
--- say) -- exactly when the ✘ matters.
---@param from integer buffer kulala runs, i.e. the scratch one
---@param source integer
---@param line integer 1-indexed, where the status is shown
---@param targets integer[]
local function run_sequence(from, source, line, targets)
    stop_mirror()

    local icons = require('kulala.config').get().icons.inlay or {}
    local index, started, ticks = 0, false, 0

    local function fire()
        index = index + 1
        started = false
        vim.api.nvim_buf_call(from, function() require('kulala.ui').open_all(nil, targets[index]) end)
    end

    fire()

    mirror = vim.uv.new_timer()
    if not mirror then return end

    mirror:start(
        100,
        100,
        vim.schedule_wrap(function()
            ticks = ticks + 1
            -- 60s, longer than any request kulala will still be waiting on.
            if ticks > 600 or not vim.api.nvim_buf_is_valid(source) then return stop_mirror() end

            local chunks, settled, failed = inlay_chunks(from, icons)

            -- Kulala clears the namespace when a run begins, so an empty or
            -- loading state is how this request announces itself. Without that
            -- the previous request's ✔ would read as this one finishing.
            if not chunks or not settled then started = true end
            if not chunks then return end

            vim.api.nvim_buf_clear_namespace(source, NS, line - 1, line)
            vim.api.nvim_buf_set_extmark(source, NS, line - 1, 0, { virt_text = chunks, hl_mode = 'combine' })

            if not (settled and started) then return end
            -- Stop on failure: whatever follows was almost certainly relying on
            -- the request that just failed.
            if failed or index >= #targets then return stop_mirror() end
            fire()
        end)
    )
end

--- Send the request under the cursor, looking inside comments in source files.
function M.run()
    local kulala = require 'kulala'
    local ft = vim.bo.filetype

    -- A run that is not ours must not keep writing to a stale anchor.
    stop_mirror()

    -- In an .http buffer kulala's own handling is already right, selections
    -- included.
    if ft == 'http' or ft == 'rest' then return kulala.run() end

    -- A linewise selection goes through the same stripping: kulala's own visual
    -- path passes the lines on verbatim, so a selection of commented ones parses
    -- as nothing but comments. Spelled out rather than `and/or`, which would
    -- truncate the call to a single return value.
    local path = vim.api.nvim_buf_get_name(0)
    if path == '' then path = vim.fs.joinpath(vim.uv.cwd(), 'unnamed') end
    local preamble, blocks = shared_document(path)

    local lines, anchor, target, expanded
    if vim.api.nvim_get_mode().mode == 'V' then
        lines, anchor, target, expanded = selection_request(blocks)
    else
        lines, anchor, target, expanded = block_request(vim.api.nvim_win_get_cursor(0)[1], blocks)
    end

    -- Not in a comment; let kulala try the current line or a fence as usual.
    if not lines or not anchor or not target then return kulala.run() end

    local doc = preamble
    if #doc > 0 then doc[#doc + 1] = '' end
    local offset = #doc
    vim.list_extend(doc, lines)

    local buf = scratch_buf(path)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, doc)

    local source = vim.api.nvim_get_current_buf()

    -- Kulala only ever clears this namespace on the buffer it ran, so marks left
    -- on earlier blocks have to go here. The first ⏳ is set directly for
    -- immediate feedback; the mirror takes over from the next tick.
    vim.api.nvim_buf_clear_namespace(source, NS, 0, -1)
    vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1)
    require('kulala.inlay').show(source, 'loading', anchor, '')

    -- An expanded `run #name` sends each block in document order, so the shared
    -- request goes first and can hand values on through `client.global.set`.
    -- Otherwise just this request, by line, so a block holding several sends only
    -- the one under the cursor. Going through kulala's `run()` would instead
    -- resolve against the *source* buffer's cursor line.
    local targets = {}
    if expanded then
        for i, text in ipairs(lines) do
            if text:match '^###' then targets[#targets + 1] = offset + i end
        end
    end
    if #targets == 0 then targets = { offset + target } end

    run_sequence(buf, source, anchor, targets)
end

return M
