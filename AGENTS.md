# Dotfiles

## CRITICAL RULES — MUST FOLLOW

**ONLY modify files inside `/Users/polo/dotfiles/`.**

- `~/.config/` (via GNU Stow) and `~/.agents/skills/` are symlinks pointing back into this repo. Always edit source files here, never the symlink targets.

## Layout

```
.agents/skills/   global Pi skills (linked to ~/.agents/skills via `just link`)
.pi/              Pi config + project-local skills under .pi/skills/
<tool>/           per-tool config dirs stowed into ~/.config/<tool>
```
