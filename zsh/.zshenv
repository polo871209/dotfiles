export EDITOR=nvim
export KUBE_EDITOR=nvim
export PAGER="bat --paging=always"
export MANPAGER="bat -plman"
export LESS=-iRFX

export GOPATH="$HOME/.local/share/go"

export CLOUDSDK_CONFIG="$HOME/.gcloud"
export CLOUDSDK_PYTHON="$HOME/.local/share/mise/installs/python/3.14/bin/python3"
export CLOUDSDK_PYTHON_SITEPACKAGES=1
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"

export DOCKER_DEFAULT_PLATFORM=linux/amd64

export OBSIDIAN_VAULT="$HOME/vault/obsidian"
export HOMEBREW_NO_ENV_HINTS=1

typeset -U path
path=($ZDOTDIR/scripts $path)
