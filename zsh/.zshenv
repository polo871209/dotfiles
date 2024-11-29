export CLOUDSDK_CONFIG="$HOME/.gcloud"
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"

export BAT_THEME="OneHalfDark"
export EDITOR="nvim"
export PAGER="bat --paging=always"
export MANPAGER="sh -c 'col -bx | bat -l man -p'"
export KUBE_EDITOR=vim

export GOPATH=$HOME/go
export PATH=$PATH:$GOPATH/bin
export PATH=$PATH:~/dotfiles/scripts

export DOCKER_DEFAULT_PLATFORM=linux/amd64
export DOCKER_HOST="$(docker context inspect | jq -r '.[].Endpoints.docker.Host')"
export POETRY_VIRTUALENVS_IN_PROJECT=true
export TERM=xterm-256color
export HISTFILE="$HOME/.zsh_history"
