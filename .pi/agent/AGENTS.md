# Pi config

This is the source for `~/.pi` (symlinked via `just link`: `ln -sfn {{dotfiles}}/.pi ~/.pi`).

Only edit files under `~/dotfiles/.pi/agent/`. Never edit `~/.pi/*` directly — it's a symlink target, changes there don't persist and won't be tracked by git.
