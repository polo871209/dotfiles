zmodload zsh/datetime zsh/system
autoload -Uz add-zsh-hook add-zle-hook-widget

export VIRTUAL_ENV_DISABLE_PROMPT=1
ZLE_RPROMPT_INDENT=0
PS2=$'%{\e[38;2;131;165;152m%}> %{\e[0m%}'

_zp_preexec() {
  _zp_cancel_fresh
  trap - INT
  print -n "\e]133;C\a"
  _zp_started=$EPOCHREALTIME
}

_zp_precmd() {
  local -i last_status=$? ran=0 duration=-1
  if [[ -n $_zp_started ]]; then
    ran=1
    duration=$(( (EPOCHREALTIME - _zp_started) * 1000 ))
    _zp_started=
  fi
  unsetopt prompt_subst prompt_bang
  setopt prompt_percent
  _zp_args=($last_status $ran $duration $COLUMNS)
  _zp_cancel_fresh
  _zp_show "$($_zp_bin prompt cached $_zp_args)"
  _zp_tooltip=
  _zp_tooltip_word=
  RPROMPT=$_zp_right
  if [[ -o zle ]]; then
    exec {_zp_fresh_fd}< <($_zp_bin prompt fresh $_zp_args)
    _zp_fresh_pid=$sysparams[procsubstpid]
    zle -F -w $_zp_fresh_fd _zp_show_fresh
  fi
  # zsh skips zle-line-finish when Ctrl-C aborts the line.
  trap 'zle && _zp_line_finish; return 130' INT
}

_zp_report_pwd() {
  [[ $PWD == "$_zp_reported_pwd" ]] && return
  _zp_reported_pwd=$PWD
  setopt local_options extended_glob no_multibyte
  print -rn -- $'\e]7;file://'$HOST${PWD//(#m)[^A-Za-z0-9\/._~-]/%${(l:2::0:)$(( [##16] #MATCH ))}}$'\e\\'
}

_zp_show() {
  local -a rendered=("${(@0)1}")
  PROMPT=${rendered[1]:-'%~ %# '}
  _zp_right=$rendered[2]
  _zp_transient=${rendered[3]:-$PROMPT}
}

_zp_show_fresh() {
  local output chunk
  while sysread -i $1 chunk; do output+=$chunk; done
  _zp_fresh_pid=
  _zp_cancel_fresh
  [[ -n $output ]] || return
  local left_before=$PROMPT right_before=$RPROMPT
  _zp_show "$output"
  RPROMPT=${_zp_tooltip:-$_zp_right}
  [[ $PROMPT == "$left_before" && $RPROMPT == "$right_before" ]] && return
  zle .reset-prompt
}

_zp_cancel_fresh() {
  (( _zp_fresh_fd )) || return
  zle -F $_zp_fresh_fd 2>/dev/null
  exec {_zp_fresh_fd}<&-
  _zp_fresh_fd=0
  [[ -n $_zp_fresh_pid ]] && kill $_zp_fresh_pid 2>/dev/null
  _zp_fresh_pid=
}

_zp_line_finish() {
  PROMPT=$_zp_transient
  RPROMPT=
  zle .reset-prompt
  zle -R
}

_zp_space_with_gcloud_tooltip() {
  zle self-insert
  local word=${${(MS)BUFFER##[[:graph:]]*}%%[[:space:]]*}
  [[ $word == "$_zp_tooltip_word" ]] && return
  _zp_tooltip_word=$word
  _zp_tooltip=
  [[ $word == (gcloud|gc) ]] && _zp_tooltip=$($_zp_bin tooltip)
  local right=${_zp_tooltip:-$_zp_right}
  [[ $right == "$RPROMPT" ]] && return
  RPROMPT=$right
  zle .reset-prompt
}

typeset -gi _zp_fresh_fd
add-zsh-hook preexec _zp_preexec
add-zsh-hook precmd _zp_precmd
add-zsh-hook precmd _zp_report_pwd
add-zle-hook-widget zle-line-finish _zp_line_finish
zle -N _zp_show_fresh
zle -N _zp_space_with_gcloud_tooltip
bindkey -M viins ' ' _zp_space_with_gcloud_tooltip
bindkey -M emacs ' ' _zp_space_with_gcloud_tooltip
