setopt prompt_subst

# Autocompletion Configuration
autoload -Uz compinit; compinit
export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
source <(carapace _carapace)
source <(kubectl-argo-rollouts completion zsh)

# ZSH Plugin Sources
source $(brew --prefix)/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source $(brew --prefix)/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
source $HOME/dotfiles/zsh/plugins/autoswitch_virtualenv.zsh

# Aliases
alias -g c="pbcopy"
alias -g cafe="fastfetch && caffeinate -d"
alias -g cls="clear"
alias -g lg="lazygit"
alias ll="eza --group-directories-first -a --icons"
alias -g k="kubectl"
alias -g kctx="kubectx"
alias -g ka="kubectl-argo-rollouts"
alias -g kns="kubens"
alias -g n="nvim"
alias -g o="open ."
alias -g oc="opencode"
alias -g tf="terraform"
alias -g watch="hwatch"
alias -g y="yank"

## Configuration Reloads & Updates
alias -g brewup="brew update && brew upgrade"
alias -g st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias -g sz="source ${ZDOTDIR:-$HOME}/.zshrc"

## Bat
alias -g bat="bat --color=always"
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


# sesh
function sesh-sessions() {
  {
    exec </dev/tty
    exec <&1
    local session
    session=$(sesh list -tcd | fzf --height 40% --reverse --border-label ' sesh ' --border --prompt '⚡  ')
    zle reset-prompt > /dev/null 2>&1 || true
    [[ -z "$session" ]] && return
    sesh connect $session
  }
}
alias -g s=sesh-sessions

# docker dive local image
divelocal() {
    dive <(docker save "$1") --source=docker-archive "${@:2}"
}

# Secret
source "$ZDOTDIR/.zshenv.secret"
# export OBSIDIAN_API_KEY=
# export BRAVE_API_KEY
# export BW_SESSION=
# export GITHUB_PERSONAL_ACCESS_TOKEN=

eval "$(oh-my-posh init zsh --config $XDG_CONFIG_HOME/ohmyposh/config.yaml)"
eval "$(atuin init zsh)"
eval "$(direnv hook zsh)"
eval "$(zoxide init zsh)"
