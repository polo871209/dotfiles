# Application Paths
export GOPATH="$HOME/go"
export OBSIDIAN_VAULT="$HOME/vaults/obsidian"

typeset -U path
path=(
  "$GOPATH/bin"
  /opt/homebrew/bin
  /opt/homebrew/opt/node/bin
  /opt/homebrew/opt/libpq/bin
  /Applications/Obsidian.app/Contents/MacOS
  ~/dotfiles/scripts
  ~/.local/bin
  ~/.cargo/bin
  $path
)

# Shell Configuration
export CLOUDSDK_CONFIG="$HOME/.gcloud"
export CLOUDSDK_PYTHON=/opt/homebrew/bin/python3
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"

export EDITOR=nvim
export HOMEBREW_NO_ENV_HINTS=1
export KUBE_EDITOR=nvim
export LESS=-iRFX
export MANPAGER="bat -plman"
export PAGER="bat --paging=always"
export TERM=xterm-256color
