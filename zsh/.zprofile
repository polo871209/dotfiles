# Set PATH here, not in .zshenv, because /etc/zprofile runs path_helper, which reorders PATH.
# Rex runs commands in a non-interactive login shell, which skips .zshrc.
typeset -U path
path=(
  ~/.local/share/mise/shims
  ~/.local/bin
  /opt/homebrew/opt/libpq/bin
  /Applications/Obsidian.app/Contents/MacOS
  /opt/homebrew/bin
  /opt/homebrew/sbin
  $path
)

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :
