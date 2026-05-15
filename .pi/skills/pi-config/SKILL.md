---
name: pi-config
description: Read before editing or creating any file under .pi/ (settings, keybindings, extensions, themes, system prompt). Explains Pi config layout, stow setup, and PI_CODING_AGENT_DIR resolution in this repo.
---

# Pi Configuration

`PI_CODING_AGENT_DIR` is set to `$XDG_CONFIG_HOME/.pi/agent`.

This repo uses GNU Stow with target `~/.config`, so `.pi/` stows to `~/.config/.pi/` — which resolves to `PI_CODING_AGENT_DIR`.

## File Locations (in repo)

| File                         | Purpose            |
| ---------------------------- | ------------------ |
| `.pi/agent/settings.json`    | Global Pi settings |
| `.pi/agent/keybindings.json` | Keybindings        |
| `.pi/agent/extensions/`      | Extensions         |
| `.pi/agent/themes/`          | Themes             |

Note: Pi only reads files under `.pi/agent/` (since `PI_CODING_AGENT_DIR` points there). Do not create a `.pi/settings.json` at the root — it will be ignored.

## Skills

- Project skills (this repo only): `.pi/skills/`
- Global skills (linked into `~/.agents/skills/` via `just link`): `.agents/skills/`
