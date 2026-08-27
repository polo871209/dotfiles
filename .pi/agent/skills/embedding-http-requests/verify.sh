#!/bin/bash
# verify.sh FILE LINE [WAIT] -- send the embedded request at FILE:LINE headlessly,
# print the response codes and the inlay left on the source comment.
set -u
FILE=$1
LINE=$2
WAIT=${3:-25}

nvim --headless "$FILE" -c 'sleep 4' \
    -c "lua vim.api.nvim_win_set_cursor(0,{$LINE,0}); require('kulala_embed').run()" \
    -c "sleep $WAIT" \
    -c 'lua
local NS = vim.api.nvim_create_namespace("kulala_inlay_hints")
local rs = require("kulala.db").global_update().responses or {}
local codes = {}
for i = 1, #rs do
    local r = rs[i] or {}
    codes[#codes + 1] = tostring(r.method) .. ":" .. tostring(r.response_code)
end
local inlay = "none"
for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, NS, 0, -1, { details = true })) do
    local parts = {}
    for _, c in ipairs((m[4] or {}).virt_text or {}) do parts[#parts + 1] = c[1] end
    inlay = ("L%d %q"):format(m[2] + 1, table.concat(parts))
end
io.stderr:write(("\nRESULT n=%d %s | inlay %s\n"):format(#rs, table.concat(codes, " "), inlay))' \
    -c 'qa!' 2>&1 | grep -oE "RESULT n=.*"
