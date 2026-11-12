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
alias ls="eza --group-directories-first -a --icons=auto"
alias n="nvim"
alias o="open ."
# The worktree pi extension writes the session's folder to PI_CWD_FILE, so the shell ends in the folder pi ended in.
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

# clone <url> [dir]: repository in dir/.bare, one folder per branch, file contents fetched on first use.
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

# wt [branch | done]: in a repo made by clone, from any folder inside it. wt branch goes to the branch's folder and creates it if missing, wt picks a folder, and wt done removes this clean folder and goes back to the default branch.
wt() {
  local root=$PWD
  while [[ $root != / && ! -d $root/.bare ]]; do root=${root:h}; done
  if [[ ! -d $root/.bare ]]; then
    print -u2 "wt: no .bare folder above $PWD. Clone the repo with clone <url>."
    return 1
  fi
  root=${root:A}
  local default=${$(git -C $root symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)#origin/}
  if [[ -z $default ]]; then
    print -u2 "wt: origin/HEAD is not set. Run git remote set-head origin --auto in $root."
    return 1
  fi
  local -A folder_of
  local line folder
  for line in ${(f)"$(git -C $root worktree list --porcelain)"}; do
    case $line in
      worktree\ *) folder=${line#worktree } ;;
      branch\ *) folder_of[${line#branch refs/heads/}]=$folder ;;
    esac
  done

  case $1 in
    "")
      local pick=$(print -l ${(k)folder_of} | fzf --prompt "${root:t} worktree> ")
      [[ -n $pick ]] && cd $folder_of[$pick]
      ;;
    done)
      local branch=$2
      if [[ -n $branch ]]; then
        folder=$folder_of[$branch]
        if [[ -z $folder ]] && ! git -C $root show-ref --verify --quiet refs/heads/$branch; then
          print -u2 "wt: no folder or local branch is named $branch."
          return 1
        fi
      else
        folder=$(git rev-parse --show-toplevel 2>/dev/null)
        if [[ -z $folder || $folder == $root ]]; then
          print -u2 "wt: $PWD is not in a branch folder."
          return 1
        fi
        branch=$(git -C $folder branch --show-current)
      fi
      if [[ $branch == $default ]]; then
        print -u2 "wt: $branch is the default branch, and it stays."
        return 1
      fi
      if [[ -n $folder ]]; then
        if [[ $PWD/ == $folder/* ]]; then wt $default || return; fi
        git -C $root worktree remove --force $folder || return
        local dir=${folder:h}
        while [[ $dir == $root/* ]] && rmdir $dir 2>/dev/null; do dir=${dir:h}; done
        print "Removed $folder."
      fi
      [[ -z $branch ]] || git -C $root branch -D $branch
      ;;
    *)
      if [[ -n $folder_of[$1] ]]; then
        cd $folder_of[$1]
        return
      fi
      git check-ref-format --branch $1 >/dev/null || return
      if git -C $root show-ref --verify --quiet refs/heads/$1; then
        git -C $root worktree add $root/$1 $1
      elif git -C $root show-ref --verify --quiet refs/remotes/origin/$1; then
        git -C $root worktree add --track -b $1 $root/$1 origin/$1
      else
        git -C $root worktree add -b $1 $root/$1 $default
      fi || return
      local home=$folder_of[$default] file
      for file in $home/(.env|.env.*|mise.toml|mise.*.toml|.mise.toml|.mise.*.toml)(N); do
        git -C $home check-ignore -q ${file:t} && cp $file $root/$1/
      done
      cd $root/$1
      ;;
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
_pi_resume_file=${XDG_STATE_HOME:-$HOME/.local/state}/pi/rex-resume/${REX_BLOCK#block:}
if [[ -n $REX_BLOCK ]] && (( SHLVL == 1 )) && [[ -r $_pi_resume_file ]]; then
  _pi_resume_session=$(<$_pi_resume_file)
  _pi_resume_precmd() {
    precmd_functions=(${precmd_functions:#_pi_resume_precmd})
    if [[ -f $_pi_resume_session ]]; then
      pi --session "$_pi_resume_session"
    else
      pi
    fi
  }
  precmd_functions+=(_pi_resume_precmd)
fi
unset _pi_resume_file
