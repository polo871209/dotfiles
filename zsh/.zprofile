# Set PATH here, not in .zshenv, because /etc/zprofile runs path_helper, which reorders PATH.
# Rex runs commands in a non-interactive login shell, which skips .zshrc.
typeset -U path
# A mise shim call costs about 35 ms with our toolset, so shell hooks and startup calls use the global install link: https://mise.jdx.dev/ide-integration.html#global-version-link
path=(
  ~/.local/share/mise/installs/atuin/global/atuin-*(N/)
  ~/.local/share/mise/installs/{carapace,zoxide}/global(N-/)
  ~/.local/share/mise/installs/gh/global/*/bin(N/)
  ~/.local/share/mise/shims
  ~/.local/bin
  /Applications/Obsidian.app/Contents/MacOS
  /opt/homebrew/bin
  /opt/homebrew/sbin
  $path
)

source ~/.orbstack/shell/init.zsh 2>/dev/null || :
