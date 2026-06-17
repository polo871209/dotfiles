# Editors & Pagers
export EDITOR=nvim
export KUBE_EDITOR=nvim
export PAGER="bat --paging=always"
export MANPAGER="bat -plman"
export LESS=-iRFX

# Go
export GOPATH="$HOME/go"

# Google Cloud
export CLOUDSDK_CONFIG="$HOME/.gcloud"
export CLOUDSDK_PYTHON="$HOME/.local/share/mise/shims/python3"
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"

# Docker
export DOCKER_DEFAULT_PLATFORM=linux/amd64

# GitHub
export GITHUB_TOKEN="$(gh auth token 2>/dev/null)"

# Misc
export OBSIDIAN_VAULT="$HOME/vaults/obsidian"
export HOMEBREW_NO_ENV_HINTS=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
export TERM=xterm-256color
