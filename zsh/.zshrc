typeset -U path
path=(
  ~/dotfiles/scripts
  ~/.local/bin
  ~/.cargo/bin
  ~/.bun/bin
  ~/.local/share/mise/shims
  "$GOPATH/bin"
  /opt/homebrew/opt/llvm/bin
  /opt/homebrew/opt/node/bin
  /opt/homebrew/opt/libpq/bin
  /Applications/Obsidian.app/Contents/MacOS
  $path
)

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
# Regenerate dump only once per day; use cached version otherwise (~15ms saved/run)
if [[ -n "${ZDOTDIR:-$HOME}/.zcompdump"(#qN.mh+24) ]]; then
  compinit -u
else
  compinit -u -C
fi

export CARAPACE_BRIDGES="zsh,fish,bash,inshellisense"
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'

_eval_cache() {
  local cmd="$1" cache="${XDG_CACHE_HOME:-$HOME/.cache}/zsh/$2.zsh"
  local bin_path="${commands[$cmd]}"
  local extra_dep="$3"

  [[ -z "$bin_path" ]] && return

  if [[ ! -f "$cache" || "$bin_path" -nt "$cache" || ( -n "$extra_dep" && "$extra_dep" -nt "$cache" ) ]]; then
    mkdir -p "${cache:h}"
    "${@:4}" > "$cache"
  fi

  if [[ ! -f "$cache.zwc" || "$cache" -nt "$cache.zwc" ]]; then
    zcompile -R "$cache" 2>/dev/null || true
  fi

  source "$cache"
}

_eval_cache carapace carapace "" carapace _carapace

# ZSH Plugin Sources — hardcode prefix to avoid forking brew each startup (~20ms)
source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

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
zstyle ':zle:edit-command-line' editor nvim -c 'set filetype=bash'
bindkey -M vicmd 'v' edit-command-line

# Aliases
alias cafe="caffeinate -id weathr --hide-location"
alias gc="gcloud config configurations activate"
alias k="kubectl"
alias kctx="kubectx"
alias kns="kubens"
alias ks="k9s"
alias lg="lazygit"
alias ls="eza --group-directories-first -a --icons"
alias n="nvim"
alias o="open ."
alias oc="opencode --port --continue"
p() { clear; command pi --continue "$@"; clear; }
alias pwd="pwd | pbcopy"
alias st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"
alias tf="terraform"
alias up="brew update && brew upgrade && brew cleanup && pi update"

## Bat
export BAT_PAGER="less -iRFK"
alias bat="bat --color=always"
alias -g -- --help='--help 2>&1 | bat --language=help --style=plain'

# FZF
export FZF_DEFAULT_COMMAND="fd --hidden --strip-cwd-prefix --exclude .git --exclude .venv"
export FZF_DEFAULT_OPTS="--select-1"
nf() {
    local file
    file=$(fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    [[ -z "$file" ]] && return
    [[ -d "$file" ]] && cd "$file" && nvim || nvim "$file"
}

sesh-sessions() {
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
    sesh connect "$session"
  }
}
alias s=sesh-sessions

divelocal() {
    dive <(docker save "$1") --source=docker-archive "${@:2}"
}

# Tool Integrations
_eval_cache uv       uv       ""  uv generate-shell-completion zsh
_eval_cache direnv   direnv   ""  direnv hook zsh
_eval_cache zoxide   zoxide   ""  zoxide init zsh
_eval_cache atuin    atuin    ""  atuin init zsh
_eval_cache oh-my-posh oh-my-posh "${XDG_CONFIG_HOME}/ohmyposh/config.yaml" oh-my-posh init zsh --config "${XDG_CONFIG_HOME}/ohmyposh/config.yaml" --eval
unfunction _eval_cache
