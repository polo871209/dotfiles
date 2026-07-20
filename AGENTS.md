# Config files

**ONLY modify files inside `~/dotfiles/`.**

`~/.config/` (via GNU Stow) and `~/.pi` (via `just link`: `ln -sfn {{dotfiles}}/.pi ~/.pi`) are symlinks pointing back into this repo. `~/.pi` resolves to `/Users/ching-polo/dotfiles/.pi`. Always edit source files here, never the symlink targets.
