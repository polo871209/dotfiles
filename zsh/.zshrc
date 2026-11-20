HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"
HISTSIZE=50000
SAVEHIST=50000
setopt EXTENDED_HISTORY
setopt HIST_EXPIRE_DUPS_FIRST
setopt HIST_FIND_NO_DUPS
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_IGNORE_SPACE
setopt HIST_SAVE_NO_DUPS
setopt SHARE_HISTORY

autoload -Uz compinit
() {
  if (( $# )); then compinit -u; else compinit -u -C; fi
} ${ZDOTDIR:-$HOME}/.zcompdump(N.mh+24)

zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'

# The first line of each cache holds the resolved binary path, because mise keeps the release archive's mtime on each binary, so an upgrade can leave the binary older than its cache.
_eval_cache() {
  local config
  [[ $1 == --config ]] && config=$2 && shift 2
  whence -p $1 >/dev/null || return
  local bin==$1 cache=${XDG_CACHE_HOME:-$HOME/.cache}/zsh/$1.zsh stamp
  local header="# ${bin:A} $*"
  [[ -e $config ]] && header+=" < ${config:A}"
  [[ -r $cache ]] && read -r stamp < $cache
  if [[ $stamp != "$header" || $bin -nt $cache || $config -nt $cache ]]; then
    mkdir -p ${cache:h}
    if ! { print -r -- $header && "$@" } > $cache.$$ || ! mv -f $cache.$$ $cache; then
      rm -f $cache.$$
      return 1
    fi
    zcompile -R $cache
  fi
  source $cache
}

_eval_cache carapace _carapace

# Binds the widgets once, at the first prompt, instead of at every prompt (5 ms each).
ZSH_AUTOSUGGEST_MANUAL_REBIND=1
# Fetches each suggestion in the background, because atuin's strategy starts a 10 ms `atuin search` per keystroke.
ZSH_AUTOSUGGEST_USE_ASYNC=1
source $ZDOTDIR/zsh-autosuggestions.zsh
source $ZDOTDIR/zsh-syntax-highlighting.zsh

bindkey -v

function zle-keymap-select {
  if [[ ${KEYMAP} == vicmd ]] ; then
    echo -ne "\e[1 q"
  else
    echo -ne "\e[5 q"
  fi
}
zle -N zle-keymap-select

function zle-line-init {
  echo -ne "\e[5 q"
}
zle -N zle-line-init

autoload -Uz edit-command-line
zle -N edit-command-line
zstyle ':zle:edit-command-line' editor nvim -c 'set filetype=bash' -c 'let b:shell_cmdline = 1'
bindkey -M vicmd 'v' edit-command-line

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
alias ls="eza --group-directories-first -a --icons=auto"
alias n="nvim"
alias o="open ."
pi() {
  local cwd_file=$(mktemp -t pi-cwd)
  PI_CWD_FILE=$cwd_file PI_CWD_SHELL=$$ command pi "$@"
  local code=$? dir=$(<$cwd_file)
  rm -f $cwd_file
  [[ -d $dir && $dir != $PWD ]] && cd $dir
  return $code
}
p() { clear; pi --continue "$@"; clear; }
alias pwd='printf %s "$PWD" | pbcopy'
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"
alias tf="terraform"
alias up="brew update && brew upgrade -y && brew cleanup && mise upgrade && mise prune -y && pi update && pi update --extensions"
alias brewdump="brew bundle dump --force --file=~/dotfiles/Brewfile --formula --cask --tap --mas --no-describe"
db() {
  docker start pg18 >/dev/null 2>&1 ||
    docker run -d --name pg18 -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=default \
      -v pgdata18:/var/lib/postgresql -p 127.0.0.1::5432 postgres:18 >/dev/null || return
  until docker exec pg18 pg_isready -h localhost -q 2>/dev/null; do sleep 1; done
  pgcli "postgres://postgres:pg@$(docker port pg18 5432/tcp)/default"
}

clone() {
  if (( $# < 1 || $# > 2 )); then
    print -u2 "usage: clone <url> [dir]"
    return 1
  fi
  local dir=${2:-${${${1:t}##*:}%.git}} branch
  if [[ -e $dir ]]; then
    print -u2 "clone: $dir already exists"
    return 1
  fi
  mkdir -p "$dir" || return
  if ! {
    git -C "$dir" init -q --bare .bare &&
      print "gitdir: ./.bare" > "$dir/.git" &&
      git -C "$dir" remote add origin "$1" &&
      git -C "$dir" fetch --filter=blob:none origin &&
      git -C "$dir" remote set-head origin --auto >/dev/null &&
      branch=${$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD)#origin/} &&
      git -C "$dir" worktree add -q --track -b "$branch" "$branch" "origin/$branch" &&
      git -C "$dir" symbolic-ref HEAD "refs/heads/$branch"
  }; then
    rm -rf "$dir"
    return 1
  fi
  cd "$dir/$branch"
}

wt() {
  local dir
  case $1 in
    "")
      local list
      list=$(git wt) || return
      dir=$(print -r -- $list | fzf --delimiter '\t' --with-nth 1 --prompt 'worktree> ') && cd ${dir#*$'\t'}
      ;;
    done)
      dir=$(git wt "$@") || return
      [[ -d $PWD ]] || cd $dir
      ;;
    *) dir=$(git wt "$@") && cd $dir ;;
  esac
}

_wt() {
  local -a open local_only remote_only actions=('done:delete this folder and its branch, discarding changes')
  local line
  for line in ${(f)"$(git worktree list --porcelain 2>/dev/null)"}; do
    [[ $line == branch\ * ]] && open+=(${line#branch refs/heads/})
  done
  local_only=(${(f)"$(git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)"})
  if (( CURRENT == 3 )) && [[ $words[2] == done ]]; then
    _describe -t branches 'branch to delete with its folder' local_only
    return
  fi
  local_only=(${local_only:|open})
  remote_only=(${(f)"$(git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin 2>/dev/null)"})
  remote_only=(${${remote_only:#HEAD}:|open})
  remote_only=(${remote_only:|local_only})
  _describe -t worktrees 'worktree' open
  _describe -t branches 'local branch, new folder' local_only
  _describe -t remote-branches 'remote branch, new folder' remote_only
  _describe -t actions 'action' actions
}
compdef _wt wt
zstyle ':completion:*:*:wt:*' group-name ''

# lazygit refuses bare repos, so outside a branch folder it opens the default branch's folder.
function lg {
  if [[ $(git rev-parse --is-bare-repository 2>/dev/null) != true ]]; then
    lazygit "$@"
    return
  fi
  local root=$(git rev-parse --path-format=absolute --git-common-dir)
  local default=${$(git -C $root symbolic-ref --short refs/remotes/origin/HEAD)#origin/}
  lazygit -p ${root:h}/$default "$@"
}

export BAT_PAGER="less -iRFK"
alias bat="bat --color=always"
alias -g -- --help='--help 2>&1 | bat --language=help --style=plain'

export FZF_DEFAULT_COMMAND="fd --hidden --strip-cwd-prefix --exclude .git --exclude .venv"
export FZF_DEFAULT_OPTS="--select-1"
nf() {
    local file
    file=$(fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    [[ -z "$file" ]] && return
    [[ -d "$file" ]] && cd "$file" && nvim || nvim "$file"
}

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
  # session_default names Rex's only session after its folder. The Rex app starts that session in $HOME, so only a pane in $HOME waits for the answer to cd.
  if [[ $PWD == $HOME ]]; then
    [[ -n $(rex --timeout 1s do session_default dir="$HOME/dotfiles" 2>/dev/null) ]] && cd ~/dotfiles
  else
    rex --timeout 1s do session_default dir="$PWD" >/dev/null 2>&1 &!
  fi
fi

_eval_cache zoxide init zsh
# atuin init runs `atuin uuid` (6 ms) unless ATUIN_SESSION is set for this SHLVL, so make the same UUIDv7 here.
if [[ -z $ATUIN_SESSION || $ATUIN_SHLVL != $SHLVL ]]; then
  () {
    setopt local_options no_multibyte
    zmodload zsh/datetime zsh/system
    local random hex= byte
    sysread -s 10 random < /dev/urandom
    for byte in ${(s::)random}; do hex+=${(l:2::0:)$(( [##16] #byte ))}; done
    local -i ms=$(( EPOCHREALTIME * 1000 )) variant=$(( 8 + 0x${hex[4]} % 4 ))
    export ATUIN_SESSION=${(L):-${(l:12::0:)$(( [##16] ms ))}7${hex[1,3]}$(( [##16] variant ))${hex[5,19]}}
    export ATUIN_SHLVL=$SHLVL
  }
fi
_eval_cache --config ~/.atuin/config.toml atuin init zsh
_eval_cache zprompt init zsh
unfunction _eval_cache

# Rex lists zoxide folders in its palette only when it loads its config, so reload it when zoxide learns a folder.
if [[ $TERM_PROGRAM == rex ]] && (( $+functions[__zoxide_hook] )); then
  functions[_zoxide_add_pwd]=$functions[__zoxide_hook]
  # zoxide's doctor warns on every z unless chpwd_functions holds __zoxide_hook, so wrap it under the same name.
  __zoxide_hook() {
    {
      if zoxide query --list | grep -qxF -- "$PWD"; then
        _zoxide_add_pwd
      else
        _zoxide_add_pwd
        zoxide query --list | grep -qxF -- "$PWD" && rex config reload >/dev/null 2>&1
      fi
    } &!
  }
fi

# Rex restores a pane after a server restart as a plain shell in the same block, so rex/init.lua and pi's rex-resume.ts record by block ID the command that brings it back.
_rex_resume_file=${XDG_STATE_HOME:-$HOME/.local/state}/rex/resume/${REX_BLOCK#block:}
if [[ -n $REX_BLOCK && -z $ZSH_EXECUTION_STRING && -r $_rex_resume_file ]] && (( SHLVL == 1 )); then
  _rex_resume_command=(${(0)"$(<$_rex_resume_file)"})
  _rex_resume_precmd() {
    precmd_functions=(${precmd_functions:#_rex_resume_precmd})
    $_rex_resume_command
  }
  precmd_functions+=(_rex_resume_precmd)
fi
unset _rex_resume_file
