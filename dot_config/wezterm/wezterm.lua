--- wezterm.lua
-- __      _____ ___| |_ ___ _ __ _ __ ___
-- \ \ /\ / / _ \_  / __/ _ \ '__| '_ ` _ \
--  \ V  V /  __// /| ||  __/ |  | | | | | |
--   \_/\_/ \___/___|\__\___|_|  |_| |_| |_|

-- Pull in wezterm API
local wezterm = require("wezterm")
local act = wezterm.action
local config = {}

-- Settings
config.color_scheme = "Gruvbox dark, medium (base16)"
config.font = wezterm.font("MesloLGS NF")
config.font_size = 16
config.hide_tab_bar_if_only_one_tab = true
config.scrollback_lines = 5000
-- config.window_background_opacity = 0.95
config.window_close_confirmation = "NeverPrompt"
config.window_decorations = "RESIZE"

--hyperlink
config.hyperlink_rules = wezterm.default_hyperlink_rules()

-- make task numbers clickable
-- the first matched regex group is captured in $1.
table.insert(config.hyperlink_rules, {
	regex = [[\b[tt](\d+)\b]],
	format = "https://example.com/tasks/?t=$1",
})

table.insert(config.hyperlink_rules, {
	regex = [[["]?([\w\d]{1}[-\w\d]+)(/){1}([-\w\d\.]+)["]?]],
	format = "https://www.github.com/$1/$3",
})

-- keybinding
config.leader = { key = "w", mods = "CTRL", timeout_milliseconds = 2000 }
config.keys = {
	-- Send C-w when pressing C-w twice
	{ key = "w", mods = "LEADER|CTRL", action = act.SendKey({ key = "w", mods = "CTRL" }) },
	-- Visual mode
	{ key = "v", mods = "LEADER", action = act.ActivateCopyMode },

	-- Make Option-Left&Right equivalent to Alt-b, Alt-f
	-- This are my sofle keyboard specific settings
	{ key = "LeftArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bb" }) },
	{ key = "RightArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bf" }) },

	-- Unbind keys
	-- { key = "w", mods = "CMD", action = nil },
}

-- and finally, return the configuration to wezterm
return config
