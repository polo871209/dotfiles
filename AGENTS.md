# Dotfiles

## CRITICAL RULES — MUST FOLLOW

**ONLY modify files inside `/Users/polo/dotfiles/`.**

- **NEVER read, write, or edit files under `~/.config/` directly.**
- This repo uses GNU Stow — symlinks from `~/.config/` point back into this repo. Always edit the source files here, not the symlink targets.
