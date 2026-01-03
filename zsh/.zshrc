setopt prompt_subst

# History Configuration
HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt EXTENDED_HISTORY          # Write the history file in the ':start:elapsed;command' format
setopt HIST_EXPIRE_DUPS_FIRST    # Expire a duplicate event first when trimming history
setopt HIST_FIND_NO_DUPS         # Do not display duplicates of a line previously found
setopt HIST_IGNORE_ALL_DUPS      # Delete an old recorded event if a new event is a duplicate
setopt HIST_IGNORE_SPACE         # Do not record an event starting with a space
setopt HIST_SAVE_NO_DUPS         # Do not write a duplicate event to the history file
setopt SHARE_HISTORY             # Share history between all sessions

# Autocompletion Configuration
autoload -Uz compinit
# Cache compinit for faster startup (run once per day)
if [[ -n ${ZDOTDIR}/.zcompdump(#qN.mh+24) ]]; then
  compinit
else
  compinit -C
fi
export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense'
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
source <(carapace _carapace)
# source <(kubectl-argo-rollouts completion zsh)

# ZSH Plugin Sources
BREW_PREFIX="$(brew --prefix)"
source "$BREW_PREFIX/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
source "$BREW_PREFIX/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"

# vi mode
bindkey -v
export VI_MODE_SET_CURSOR=true

# cursor style when in vi mode
function zle-keymap-select {
  if [[ ${KEYMAP} == vicmd ]] ; then
    echo -ne "\e[1 q"
  else
    echo -ne "\e[5 q"
  fi
}
zle -N zle-keymap-select

# reset cursor style on each prompt
function zle-line-init {
  echo -ne "\e[5 q"
}
zle -N zle-line-init

# v to edit the command line in editor
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey -M vicmd 'v' edit-command-line

# Aliases
alias c="pbcopy"
alias cafe="caffeinate -id asciiquarium"
alias cls="clear"
alias io="istioctl"
alias lg="lazygit"
alias l="eza --group-directories-first -a --icons"
alias j="just"
alias k="kubectl"
alias kctx="kubectx"
alias ka="kubectl-argo-rollouts"
alias kns="kubens"
alias n="nvim"
alias o="open ."
alias oc="opencode"
alias p="NVIM_PRACTICE_MODE=1 nvim /tmp/pratice.py"
alias tf="terraform"
alias watch="hwatch"
alias y="yank"

## Configuration Reloads & Updates
alias brewup="brew update && brew upgrade"
alias st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"

## Bat
export BAT_PAGER="less -iRFK"
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
    local file
    file=$(fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    [[ -z "$file" ]] && return
    [[ -d "$file" ]] && cd "$file" && nvim || nvim "$file"
}

# sesh
function sesh-sessions() {
  {
    exec </dev/tty
    exec <&1
    local session
    session=$(sesh list --icons | fzf --height 40% --reverse --border-label ' sesh ' --border --prompt '> ' \
      --ansi \
      --color 'bg:#282828,bg+:#3c3836,fg:#89b4fa,fg+:#89b4fa' \
      --color 'hl:#fabd2f,hl+:#fabd2f,info:#83a598,marker:#8ec07c' \
      --color 'prompt:#d79921,spinner:#8ec07c,pointer:#fe8019,header:#928374' \
      --color 'border:#928374,label:#ebdbb2,query:#ebdbb2')
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
[[ -f "$ZDOTDIR/.zshenv.secret" ]] && source "$ZDOTDIR/.zshenv.secret"
# export OBSIDIAN_API_KEY=
# export BRAVE_API_KEY
# export BW_SESSION=
# export GITHUB_PERSONAL_ACCESS_TOKEN=

eval "$(oh-my-posh init zsh --config $XDG_CONFIG_HOME/ohmyposh/config.yaml)"
eval "$(atuin init zsh)"
eval "$(direnv hook zsh)"
eval "$(zoxide init zsh)"
