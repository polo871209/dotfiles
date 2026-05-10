-- lsp-feedback.lua — driver invoked as:
--   nvim --headless <abs-file1> <abs-file2> ... +'luafile <this-file>'
--
-- Plain --headless (no -l) is required so the user's init.lua, plugins, and
-- vim.lsp.enable {...} run normally. Files passed as args are auto-opened as
-- buffers; we iterate over them:
--   1. open buffer, force ft + autocmds, wait for LSP attach
--   2. apply LSP code actions: source.fixAll + source.organizeImports
--      (auto-fixes from ruff/biome/eslint/typescript/etc.)
--   3. conform.nvim format (lsp_format = 'fallback')
--   4. write to disk if changed
--   5. re-pull diagnostics so the widget reflects post-fix state
--
-- Emits one JSON line on stdout, prefixed with __LSP_FEEDBACK_JSON__:
--   {"formatted":[...absPaths...],"diagnostics":[{file,line,col,severity,source,code,message}, ...]}

-- Files come in as nvim CLI args. Only the first arg is loaded into a buffer
-- by default; the rest are queued in the arg list. Read them directly via
-- vim.fn.argv() so we don't miss any — the main loop below uses `:buffer`
-- which will load each one on demand.
local files = vim.fn.argv()

local OVERALL_BUDGET_MS = 10000
local FORMAT_TIMEOUT_MS = 3000
local CODEACTION_TIMEOUT_MS = 2000
local started_at = vim.uv.now()
local function remaining()
	return math.max(0, OVERALL_BUDGET_MS - (vim.uv.now() - started_at))
end

local formatted = {}
local bufs = {}

local FIXALL_KINDS = {
	"source.fixAll",
	"source.organizeImports",
}

-- Apply non-destructive LSP code actions matching the kinds above. Workspace
-- edits are applied synchronously; commands (action.command) are skipped to
-- keep the driver predictable and side-effect-free.
local function apply_code_actions(bufnr)
	local clients = vim.lsp.get_clients({ bufnr = bufnr })
	if #clients == 0 then
		return false
	end
	local changed = false
	for _, client in ipairs(clients) do
		local enc = client.offset_encoding or "utf-16"
		for _, kind in ipairs(FIXALL_KINDS) do
			local params = vim.lsp.util.make_range_params(0, enc) --[[@as table]]
			params.context = { only = { kind }, diagnostics = vim.diagnostic.get(bufnr) or {} }
			local timeout = math.min(CODEACTION_TIMEOUT_MS, remaining())
			if timeout <= 0 then
				break
			end
			local ok, results = pcall(vim.lsp.buf_request_sync, bufnr, "textDocument/codeAction", params, timeout)
			if ok and results then
				for _, res in pairs(results) do
					for _, action in ipairs(res.result or {}) do
						if action.edit then
							pcall(vim.lsp.util.apply_workspace_edit, action.edit, enc)
							changed = true
						end
					end
				end
			end
		end
	end
	return changed
end

local function try_format(bufnr)
	local ok_conform, conform = pcall(require, "conform")
	if not ok_conform then
		return false
	end
	local before = vim.api.nvim_buf_get_changedtick(bufnr)
	pcall(function()
		conform.format({ bufnr = bufnr, async = false, lsp_format = "fallback", timeout_ms = FORMAT_TIMEOUT_MS })
	end)
	return vim.api.nvim_buf_get_changedtick(bufnr) ~= before
end

local function pull_diagnostics(bufnr)
	local clients = vim.lsp.get_clients({ bufnr = bufnr })
	for _, client in ipairs(clients) do
		local caps = client.server_capabilities or {}
		if caps.diagnosticProvider then
			local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
			pcall(vim.lsp.buf_request_sync, bufnr, "textDocument/diagnostic", params, math.min(1500, remaining()))
		end
	end
end

for _, file in ipairs(files) do
	if type(file) == "string" and vim.uv.fs_stat(file) then
		-- `:edit` loads the file (or reuses an existing buffer) and switches to
		-- it. Works reliably for every CLI-arg file, unlike `:buffer` which
		-- depends on exact name matching after path canonicalization.
		vim.cmd("edit " .. vim.fn.fnameescape(file))
		local bufnr = vim.api.nvim_get_current_buf()
		table.insert(bufs, bufnr)

		pcall(function()
			vim.cmd("filetype detect")
		end)
		pcall(function()
			vim.cmd("doautocmd BufRead")
		end)
		pcall(function()
			vim.cmd("doautocmd BufEnter")
		end)
		pcall(function()
			vim.cmd("doautocmd FileType")
		end)

		-- Wait for LSP attach so code actions and diagnostics are available.
		vim.wait(math.min(2000, remaining()), function()
			return #vim.lsp.get_clients({ bufnr = bufnr }) > 0
		end, 50)

		-- Initial diagnostics pull so code-action context has something to feed on.
		pull_diagnostics(bufnr)
		pcall(function()
			require("lint").try_lint()
		end)
		-- Brief settle for async publishDiagnostics.
		vim.wait(math.min(800, remaining()), function()
			return false
		end, 50)

		-- Auto-fix: source.fixAll + source.organizeImports (ruff/biome/eslint/ts/etc.)
		local fixed = apply_code_actions(bufnr)

		-- Format last so it cleans up anything the fix-all rearranged.
		local fmt = try_format(bufnr)

		if fixed or fmt then
			pcall(function()
				vim.api.nvim_buf_call(bufnr, function()
					vim.cmd("silent! write")
				end)
			end)
			table.insert(formatted, vim.api.nvim_buf_get_name(bufnr))
		end

		-- Re-pull diagnostics so the widget reflects post-fix state.
		pull_diagnostics(bufnr)
		pcall(function()
			require("lint").try_lint()
		end)
	end
end

-- Final settle window so any remaining async publishDiagnostics land.
vim.wait(math.min(1500, remaining()), function()
	return false
end, 50)

local out = { formatted = formatted, diagnostics = {} }
local sev = { "error", "warn", "info", "hint" }
for _, bufnr in ipairs(bufs) do
	if vim.api.nvim_buf_is_valid(bufnr) then
		for _, d in ipairs(vim.diagnostic.get(bufnr)) do
			table.insert(out.diagnostics, {
				file = vim.api.nvim_buf_get_name(bufnr),
				line = (d.lnum or 0) + 1,
				col = (d.col or 0) + 1,
				severity = sev[d.severity] or "info",
				source = d.source,
				code = d.code and tostring(d.code) or nil,
				message = d.message,
			})
		end
	end
end

io.stdout:write("\n__LSP_FEEDBACK_JSON__" .. vim.json.encode(out) .. "\n")
io.stdout:flush()
vim.cmd("qa!")
