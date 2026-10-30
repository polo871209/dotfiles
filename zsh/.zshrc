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

source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# vi mode
bindkey -v

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
zstyle ':zle:edit-command-line' editor nvim -c 'set filetype=bash' -c 'let b:shell_cmdline = 1'
bindkey -M vicmd 'v' edit-command-line

# Aliases
function cafe {
  if (( $# > 1 )) || [[ $# == 1 && $1 != <1-> ]]; then
    print -u2 "usage: cafe [minutes]"
    return 1
  fi
  # Rex drops frames and freezes at pixel ratio 1, but keeps 60 fps at 0.75.
  local garden=(opengarden --pixel-ratio 0.75)
  # caffeinate ignores -t when it runs a command.
  (( $# )) && garden=(sh -c '(sleep "$1"; kill -INT $$) & shift; exec "$@"' sh $(( $1 * 60 )) $garden)
  # Rex picks the pane icon from the process title, and opengarden otherwise shows as Node.
  garden=(env NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--title=caffeinate" caffeinate -id $garden)
  if [[ -z $REX_BLOCK ]]; then
    $garden
    return
  fi
  local zoomed=$(rex session inspect "$REX_SESSION" --json | jq -r --arg block "$REX_BLOCK" \
    '.windows[] | select(any(.layers[].blocks[]; .block_id == $block)) | .zoomed_block_id // empty')
  rex zoom --on
  {
    $garden
  } always {
    [[ $zoomed == $REX_BLOCK ]] || rex zoom --off
  }
}
alias gc="gcloud config configurations activate"
alias k="kubectl"
alias kctx="kubectx"
alias kns="kubens"
alias sk="sofka"
alias prune="docker system prune --all -f && docker volume prune --all -f"
alias lg="lazygit"
alias ls="eza --group-directories-first -a --icons=auto"
alias n="nvim"
alias o="open ."
p() { clear; command pi --continue "$@"; clear; }
alias pwd='printf %s "$PWD" | pbcopy'
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"
alias tf="terraform"
alias up="brew update && brew upgrade -y && brew cleanup && mise upgrade && mise prune -y && pi update && pi update --extensions"
alias brewdump="brew bundle dump --force --file=~/dotfiles/Brewfile --formula --cask --tap --mas --no-describe"

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

# ff [dir]: live fsearch over the whole disk, or only inside dir. A picked file opens in nvim, and a picked folder becomes the cwd.
ff() {
    local scope=${1:+in:${1:A}}
    local pick
    pick=$(: | fzf --disabled --no-select-1 --prompt "${1:+${1:A} }> " \
        --bind "change:reload:[[ -n {q} ]] && fsearch {q} '!node_modules/ !.git/ !.venv/ !__pycache__/' ${(q)scope} limit:200 2>/dev/null || true" \
        --preview '[[ -d {} ]] && eza -a --icons --color=always {} || bat --color=always --style=numbers --line-range=:500 {}')
    [[ -z "$pick" ]] && return
    if [[ -d "$pick" ]]; then cd "$pick"; else nvim "$pick"; fi
}

if [[ $TERM_PROGRAM == rex ]]; then
  alias s="$XDG_CONFIG_HOME/rex/session-picker"
  # The Rex app starts its first session in $HOME.
  () {
    local dir=$PWD
    [[ $dir == $HOME ]] && dir=$HOME/dotfiles
    [[ -n $(rex --timeout 1s do session_default dir="$dir" 2>/dev/null) ]] && cd "$dir"
  }
fi

# Tool Integrations
_eval_cache uv       uv       ""  uv generate-shell-completion zsh
_eval_cache direnv   direnv   ""  direnv hook zsh
_eval_cache zoxide   zoxide   ""  zoxide init zsh
_eval_cache atuin    atuin    ""  atuin init zsh
unfunction _eval_cache

# Rex lists zoxide folders in its palette only when it loads its config, so reload it when zoxide learns a folder.
if [[ $TERM_PROGRAM == rex ]] && (( $+functions[__zoxide_hook] )); then
  functions[_zoxide_add_pwd]=$functions[__zoxide_hook]
  # zoxide's doctor warns on every z unless chpwd_functions holds __zoxide_hook, so wrap it under the same name.
  __zoxide_hook() {
    if zoxide query --list | grep -qxF -- "$PWD"; then
      _zoxide_add_pwd
      return
    fi
    _zoxide_add_pwd
    if zoxide query --list | grep -qxF -- "$PWD"; then
      rex config reload >/dev/null 2>&1 &!
    fi
  }
fi

eval "$(oh-my-posh init zsh --config "${XDG_CONFIG_HOME}/ohmyposh/config.yaml")"

# Rex keeps block IDs across a server restart, so pi's rex-resume.ts extension records each pane's session by block ID.
# A pi that exits returns to this prompt and forgets its pane, and one killed by a restart leaves the record for the restored shell.
if [[ -n $REX_BLOCK ]]; then
  _pi_resume_file=${XDG_STATE_HOME:-$HOME/.local/state}/pi/rex-resume/${REX_BLOCK#block:}
  (( SHLVL == 1 )) && [[ -r $_pi_resume_file ]] && _pi_resume_pending=1
  _pi_resume_precmd() {
    [[ -e $_pi_resume_file ]] || return
    if (( _pi_resume_pending )); then
      _pi_resume_pending=0
      local session=$(<$_pi_resume_file)
      if [[ -f $session ]]; then
        command pi --session "$session"
      else
        command pi
      fi
    fi
    rm -f -- $_pi_resume_file
  }
  precmd_functions+=(_pi_resume_precmd)
fi
