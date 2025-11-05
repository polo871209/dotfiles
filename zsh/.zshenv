# Development Tools and PATH
export GOPATH=$HOME/go
# Deduplicate PATH entries
typeset -U path
path=(
  $GOPATH/bin
  /opt/homebrew/bin
  ~/dotfiles/scripts
  ~/.local/bin
  ~/.cargo/bin
  $path
)

# Shell Configuration
export CLOUDSDK_CONFIG="$HOME/.gcloud"
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"

export BAT_THEME="OneHalfDark"
export EDITOR="nvim"
export HWATCH="--color"
export PAGER="bat --paging=always"
export MANPAGER="sh -c 'col -bx | bat -l man -p'"
export KUBE_EDITOR=vim

export DOCKER_DEFAULT_PLATFORM=linux/amd64
# Lazy evaluation of DOCKER_HOST to avoid subprocess on every shell
export DOCKER_HOST_CMD='docker context inspect | jq -r ".[].Endpoints.docker.Host"'

export POETRY_VIRTUALENVS_IN_PROJECT=true

export TERM=xterm-256color

export HOMEBREW_NO_ENV_HINTS=1

# Application Paths
export OBSIDIAN_VAULT="$HOME/vaults/obsidian"
