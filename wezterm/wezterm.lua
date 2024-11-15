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
config.default_cursor_style = "SteadyBar"
-- config.window_background_opacity = 0.95
config.window_close_confirmation = "NeverPrompt"
config.window_decorations = "RESIZE"
config.front_end = "WebGpu"

-- keybinding
config.keys = {
	-- Make Option-Left&Right equivalent to Alt-b, Alt-f
	-- This are my sofle keyboard specific settings
	{ key = "LeftArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bb" }) },
	{ key = "RightArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bf" }) },
	{
		key = "w",
		mods = "CMD",
		action = wezterm.action.CloseCurrentTab({ confirm = false }),
	},
	-- Unbind keys
	-- { key = "w", mods = "CMD", action = nil },
}

-- and finally, return the configuration to wezterm
return config
