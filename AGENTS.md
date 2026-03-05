# Dotfiles

This repo uses GNU Stow to symlink config files into `~/.config`.

- Target: `~/.config` (set in `.stowrc`)
- Each top-level directory is a stow package (e.g. `nvim/`, `opencode/`)
- Files mirror the structure under `~/.config/` (e.g. `opencode/opencode.json` → `~/.config/opencode/opencode.json`)
- When adding or moving files, preserve the directory structure relative to `~/.config`
