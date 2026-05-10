---
name: pi-config
description: How Pi coding agent is configured in this repo — settings, extensions, themes, and skills locations.
---

# Pi Configuration

`PI_CODING_AGENT_DIR` is set to `$XDG_CONFIG_HOME/.pi/agent`.

This repo uses GNU Stow with target `~/.config`, so `.pi/` stows to `~/.config/.pi/` — which resolves to `PI_CODING_AGENT_DIR`.


## File Locations (in repo)

| File                | Purpose            |
| ------------------- | ------------------ |
| `.pi/agent/settings.json`    | Global Pi settings |
| `.pi/agent/keybindings.json` | Keybindings        |
| `.pi/agent/extensions/`      | Extensions         |
| `.pi/agent/themes/`          | Themes             |

Note: Pi only reads files under `.pi/agent/` (since `PI_CODING_AGENT_DIR` points there). Do not create a `.pi/settings.json` at the root — it will be ignored.

## Skills

Skills live in `.agents/skills/` — auto-discovered by Pi for any session inside this repo.
