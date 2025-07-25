setopt prompt_subst

# Autocompletion Configuration
autoload -Uz compinit; compinit
export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
source <(carapace _carapace)

# ZSH Plugin Sources
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source $(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source $HOME/dotfiles/zsh/plugins/autoswitch_virtualenv.zsh

# Aliases
alias c="pbcopy"
alias cafe="fastfetch && caffeinate -d"
alias cls="clear"
alias lg="lazygit"
alias ls="eza --group-directories-first -a --icons"
alias k="kubectl"
alias kctx="kubectx"
alias kns="kubens"
alias n="nvim"
alias o="open ."
alias tf="terraform"
alias y="yank"

## Configuration Reloads & Updates
alias brewup="brew update && brew upgrade && brew upgrade --greedy"
alias st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"

## Bat
alias bat="bat --color=always"
alias -g -- -h='-h 2>&1 | bat --language=help --style=plain'
alias -g -- --help='--help 2>&1 | bat --language=help --style=plain'
h() {
    "$@" --help 2>&1 | bat --plain --language=help
}

# FZF
source <(fzf --zsh)
export FZF_DEFAULT_COMMAND="fd --hidden --strip-cwd-prefix --exclude .git --exclude .venv"
export FZF_DEFAULT_OPTS="--select-1"
nf() {
    file=$(fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    [ -d $file ] && cd $file && nvim || nvim $file
}

# Functions
cs() {
    [ -f "$1.sh" ] && echo "$1.sh already exist" && return
    touch "$1.sh" && chmod +x "$1.sh"
    bat --plain  <<EOF >> "$1.sh"
#!/usr/bin/env bash
set -euo pipefail
EOF
}

# sesh
function sesh-sessions() {
  {
    exec </dev/tty
    exec <&1
    local session
    session=$(sesh list -t -c | fzf --height 40% --reverse --border-label ' sesh ' --border --prompt '⚡  ')
    zle reset-prompt > /dev/null 2>&1 || true
    [[ -z "$session" ]] && return
    sesh connect $session
  }
}
alias s=sesh-sessions

# docker dive local image
divelocal() {
    dive <(docker save "$1") --source=docker-archive "${@:2}"
}

# Secret
source "$ZDOTDIR/.zshenv.secret"
# export OBSIDIAN_API_KEY=
# export BRAVE_API_KEY

eval "$(oh-my-posh init zsh --config $XDG_CONFIG_HOME/ohmyposh/config.yaml)"
eval "$(atuin init zsh)"
eval "$(direnv hook zsh)"
eval "$(zoxide init zsh)"
