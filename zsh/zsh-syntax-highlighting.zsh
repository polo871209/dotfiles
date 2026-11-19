# Source: https://github.com/zsh-users/zsh-syntax-highlighting/tree/0.8.0
#
# Copyright (c) 2010-2020 zsh-syntax-highlighting contributors
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without modification, are permitted
# provided that the following conditions are met:
#
#  * Redistributions of source code must retain the above copyright notice, this list of conditions
#    and the following disclaimer.
#  * Redistributions in binary form must reproduce the above copyright notice, this list of
#    conditions and the following disclaimer in the documentation and/or other materials provided
#    with the distribution.
#  * Neither the name of the zsh-syntax-highlighting contributors nor the names of its contributors
#    may be used to endorse or promote products derived from this software without specific prior
#    written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
# IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
# FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
# CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
# DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
# DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
# IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
# OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/zsh-syntax-highlighting.zsh
typeset zsh_highlight__aliases="$(builtin alias -Lm '[^+]*')"
builtin unalias -m '[^+]*'

typeset -g ZSH_HIGHLIGHT_VERSION=0.8.0 ZSH_HIGHLIGHT_REVISION=db085e4661f6aafd24e5acb5b2e17e4dd5dddf3e

_zsh_highlight__function_is_autoload_stub_p() {
  if zmodload -e zsh/parameter; then
    [[ "$functions[$1]" == *"builtin autoload -X"* ]]
  else
    [[ "${${(@f)"$(which -- "$1")"}[2]}" == $'\t'$histchars[3]' undefined' ]]
  fi
}

_zsh_highlight__is_function_p() {
  if zmodload -e zsh/parameter; then
    (( ${+functions[$1]} ))
  else
    [[ $(type -wa -- "$1") == *'function'* ]]
  fi
}

_zsh_highlight__function_callable_p() {
  if _zsh_highlight__is_function_p "$1" &&
     ! _zsh_highlight__function_is_autoload_stub_p "$1"
  then
    return 0
  else
    ( autoload -U +X -- "$1" 2>/dev/null )
    return $?
  fi
}

autoload -Uz is-at-least
if is-at-least 5.4; then
  typeset -g zsh_highlight__pat_static_bug=false
else
  typeset -g zsh_highlight__pat_static_bug=true
fi

typeset -ga ZSH_HIGHLIGHT_HIGHLIGHTERS

_zsh_highlight()
{
  local ret=$?
  typeset -r ret

  (( ${+region_highlight[@]} )) || {
    echo >&2 'zsh-syntax-highlighting: error: $region_highlight is not defined'
    echo >&2 'zsh-syntax-highlighting: (Check whether zsh-syntax-highlighting was installed according to the instructions.)'
    return $ret
  }

  (( ${+zsh_highlight__memo_feature} )) || {
    region_highlight+=( " 0 0 fg=red, memo=zsh-syntax-highlighting" )
    case ${region_highlight[-1]} in
      ("0 0 fg=red")
        integer -gr zsh_highlight__memo_feature=0
        ;;
      ("0 0 fg=red memo=zsh-syntax-highlighting")
        integer -gr zsh_highlight__memo_feature=1
        ;;
      (" 0 0 fg=red, memo=zsh-syntax-highlighting") ;&
      (*)
        if is-at-least 5.9; then
          integer -gr zsh_highlight__memo_feature=1
        else
          integer -gr zsh_highlight__memo_feature=0
        fi
        ;;
    esac
    region_highlight[-1]=()
  }

  if (( zsh_highlight__memo_feature )); then
    region_highlight=( "${(@)region_highlight:#*memo=zsh-syntax-highlighting*}" )
  else
    region_highlight=()
  fi

  if [[ $WIDGET == zle-isearch-update ]] && { $zsh_highlight__pat_static_bug || ! (( $+ISEARCHMATCH_ACTIVE )) }; then
    return $ret
  fi

  local -A zsyh_user_options
  if zmodload -e zsh/parameter; then
    zsyh_user_options=("${(kv)options[@]}")
  else
    local canonical_options onoff option raw_options
    raw_options=(${(f)"$(emulate -R zsh; set -o)"})
    canonical_options=(${${${(M)raw_options:#*off}%% *}#no} ${${(M)raw_options:#*on}%% *})
    for option in "${canonical_options[@]}"; do
      [[ -o $option ]]
      case $? in
        (0) zsyh_user_options+=($option on);;
        (1) zsyh_user_options+=($option off);;
        (*)
            echo "zsh-syntax-highlighting: warning: '[[ -o $option ]]' returned $?"
            ;;
      esac
    done
  fi
  typeset -r zsyh_user_options

  emulate -L zsh
  setopt localoptions warncreateglobal nobashrematch
  local REPLY

  [[ -n ${ZSH_HIGHLIGHT_MAXLENGTH:-} ]] && [[ $#BUFFER -gt $ZSH_HIGHLIGHT_MAXLENGTH ]] && return $ret

  (( KEYS_QUEUED_COUNT > 0 )) && return $ret
  (( PENDING > 0 )) && return $ret

  {
    local cache_place
    local -a region_highlight_copy

    local highlighter; for highlighter in $ZSH_HIGHLIGHT_HIGHLIGHTERS; do
      cache_place="_zsh_highlight__highlighter_${highlighter}_cache"
      typeset -ga ${cache_place}

      if ! type "_zsh_highlight_highlighter_${highlighter}_predicate" >&/dev/null; then
        echo "zsh-syntax-highlighting: warning: disabling the ${(qq)highlighter} highlighter as it has not been loaded" >&2
        ZSH_HIGHLIGHT_HIGHLIGHTERS=( ${ZSH_HIGHLIGHT_HIGHLIGHTERS:#${highlighter}} )
      elif "_zsh_highlight_highlighter_${highlighter}_predicate"; then
        region_highlight_copy=("${region_highlight[@]}")
        region_highlight=()

        {
          "_zsh_highlight_highlighter_${highlighter}_paint"
        } always {
          : ${(AP)cache_place::="${region_highlight[@]}"}
        }

        region_highlight=("${region_highlight_copy[@]}")
      fi

      region_highlight+=("${(@P)cache_place}")
    done

    () {
      (( REGION_ACTIVE )) || return
      integer min max
      if (( MARK > CURSOR )) ; then
        min=$CURSOR max=$MARK
      else
        min=$MARK max=$CURSOR
      fi
      if (( REGION_ACTIVE == 1 )); then
        [[ $KEYMAP = vicmd ]] && (( max++ ))
      elif (( REGION_ACTIVE == 2 )); then
        local needle=$'\n'
        (( min = ${BUFFER[(Ib:min:)$needle]} ))
        (( max = ${BUFFER[(ib:max:)$needle]} - 1 ))
      fi
      _zsh_highlight_apply_zle_highlight region standout "$min" "$max"
    }

    (( $+YANK_ACTIVE )) && (( YANK_ACTIVE )) && _zsh_highlight_apply_zle_highlight paste standout "$YANK_START" "$YANK_END"

    (( $+ISEARCHMATCH_ACTIVE )) && (( ISEARCHMATCH_ACTIVE )) && _zsh_highlight_apply_zle_highlight isearch underline "$ISEARCHMATCH_START" "$ISEARCHMATCH_END"

    (( $+SUFFIX_ACTIVE )) && (( SUFFIX_ACTIVE )) && _zsh_highlight_apply_zle_highlight suffix bold "$SUFFIX_START" "$SUFFIX_END"

    return $ret
  } always {
    typeset -g _ZSH_HIGHLIGHT_PRIOR_BUFFER="$BUFFER"
    typeset -gi _ZSH_HIGHLIGHT_PRIOR_CURSOR=$CURSOR
  }
}

_zsh_highlight_apply_zle_highlight() {
  local entry="$1" default="$2"
  integer first="$3" second="$4"

  local region="${zle_highlight[(r)${entry}:*]-}"

  if [[ -z "$region" ]]; then
    region=$default
  else
    region="${region#${entry}:}"

    if [[ -z "$region" ]] || [[ "$region" == none ]]; then
      return
    fi
  fi

  integer start end
  if (( first < second )); then
    start=$first end=$second
  else
    start=$second end=$first
  fi
  region_highlight+=("$start $end $region, memo=zsh-syntax-highlighting")
}

typeset -gA ZSH_HIGHLIGHT_STYLES

_zsh_highlight_buffer_modified()
{
  [[ "${_ZSH_HIGHLIGHT_PRIOR_BUFFER:-}" != "$BUFFER" ]]
}

_zsh_highlight_cursor_moved()
{
  [[ -n $CURSOR ]] && [[ -n ${_ZSH_HIGHLIGHT_PRIOR_CURSOR-} ]] && (($_ZSH_HIGHLIGHT_PRIOR_CURSOR != $CURSOR))
}

_zsh_highlight_add_highlight()
{
  local -i start end
  local highlight
  start=$1
  end=$2
  shift 2
  for highlight; do
    if (( $+ZSH_HIGHLIGHT_STYLES[$highlight] )); then
      region_highlight+=("$start $end $ZSH_HIGHLIGHT_STYLES[$highlight], memo=zsh-syntax-highlighting")
      break
    fi
  done
}

_zsh_highlight_call_widget()
{
  builtin zle "$@" &&
  _zsh_highlight
}

if is-at-least 5.9 && _zsh_highlight__function_callable_p add-zle-hook-widget
then
  autoload -U add-zle-hook-widget
  _zsh_highlight__zle-line-finish() {
    () {
      local -h -r WIDGET=zle-line-finish
      _zsh_highlight
    }
  }
  _zsh_highlight__zle-line-pre-redraw() {
    true && _zsh_highlight "$@"
  }
  _zsh_highlight_bind_widgets(){}
  if [[ -o zle ]]; then
    add-zle-hook-widget zle-line-pre-redraw _zsh_highlight__zle-line-pre-redraw
    add-zle-hook-widget zle-line-finish _zsh_highlight__zle-line-finish
  fi
else
  _zsh_highlight_bind_widgets()
  {
    setopt localoptions noksharrays
    typeset -F SECONDS
    local prefix=orig-s$SECONDS-r$RANDOM

    zmodload zsh/zleparameter 2>/dev/null || {
      print -r -- >&2 'zsh-syntax-highlighting: failed loading zsh/zleparameter.'
      return 1
    }

    local -U widgets_to_bind
    widgets_to_bind=(${${(k)widgets}:#(.*|run-help|which-command|beep|set-local-history|yank|yank-pop)})

    widgets_to_bind+=(zle-line-finish)

    widgets_to_bind+=(zle-isearch-update)

    local cur_widget
    for cur_widget in $widgets_to_bind; do
      case ${widgets[$cur_widget]:-""} in
        user:_zsh_highlight_widget_*);;

        user:*) zle -N $prefix-$cur_widget ${widgets[$cur_widget]#*:}
                eval "_zsh_highlight_widget_${(q)prefix}-${(q)cur_widget}() { _zsh_highlight_call_widget ${(q)prefix}-${(q)cur_widget} -- \"\$@\" }"
                zle -N $cur_widget _zsh_highlight_widget_$prefix-$cur_widget;;

        completion:*) zle -C $prefix-$cur_widget ${${(s.:.)widgets[$cur_widget]}[2,3]}
                      eval "_zsh_highlight_widget_${(q)prefix}-${(q)cur_widget}() { _zsh_highlight_call_widget ${(q)prefix}-${(q)cur_widget} -- \"\$@\" }"
                      zle -N $cur_widget _zsh_highlight_widget_$prefix-$cur_widget;;

        builtin) eval "_zsh_highlight_widget_${(q)prefix}-${(q)cur_widget}() { _zsh_highlight_call_widget .${(q)cur_widget} -- \"\$@\" }"
                 zle -N $cur_widget _zsh_highlight_widget_$prefix-$cur_widget;;

        *)
           if [[ $cur_widget == zle-* ]] && (( ! ${+widgets[$cur_widget]} )); then
             _zsh_highlight_widget_${cur_widget}() { :; _zsh_highlight }
             zle -N $cur_widget _zsh_highlight_widget_$cur_widget
           else
             print -r -- >&2 "zsh-syntax-highlighting: unhandled ZLE widget ${(qq)cur_widget}"
             print -r -- >&2 "zsh-syntax-highlighting: (This is sometimes caused by doing \`bindkey <keys> ${(q-)cur_widget}\` without creating the ${(qq)cur_widget} widget with \`zle -N\` or \`zle -C\`.)"
           fi
      esac
    done
  }
fi

_zsh_highlight_bind_widgets || {
  print -r -- >&2 'zsh-syntax-highlighting: failed binding ZLE widgets, exiting.'
  return 1
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/brackets/brackets-highlighter.zsh
: ${ZSH_HIGHLIGHT_STYLES[bracket-error]:=fg=red,bold}
: ${ZSH_HIGHLIGHT_STYLES[bracket-level-1]:=fg=blue,bold}
: ${ZSH_HIGHLIGHT_STYLES[bracket-level-2]:=fg=green,bold}
: ${ZSH_HIGHLIGHT_STYLES[bracket-level-3]:=fg=magenta,bold}
: ${ZSH_HIGHLIGHT_STYLES[bracket-level-4]:=fg=yellow,bold}
: ${ZSH_HIGHLIGHT_STYLES[bracket-level-5]:=fg=cyan,bold}
: ${ZSH_HIGHLIGHT_STYLES[cursor-matchingbracket]:=standout}

_zsh_highlight_highlighter_brackets_predicate()
{
  [[ $WIDGET == zle-line-finish ]] || _zsh_highlight_cursor_moved || _zsh_highlight_buffer_modified
}

_zsh_highlight_highlighter_brackets_paint()
{
  local char style
  local -i bracket_color_size=${#ZSH_HIGHLIGHT_STYLES[(I)bracket-level-*]} buflen=${#BUFFER} level=0 matchingpos pos
  local -A levelpos lastoflevel matching

  pos=0
  for char in ${(s..)BUFFER} ; do
    (( ++pos ))
    case $char in
      ["([{"])
        levelpos[$pos]=$((++level))
        lastoflevel[$level]=$pos
        ;;
      [")]}"])
        if (( level > 0 )); then
          matchingpos=$lastoflevel[$level]
          levelpos[$pos]=$((level--))
          if _zsh_highlight_brackets_match $matchingpos $pos; then
            matching[$matchingpos]=$pos
            matching[$pos]=$matchingpos
          fi
        else
          levelpos[$pos]=-1
        fi
        ;;
    esac
  done

  for pos in ${(k)levelpos}; do
    if (( $+matching[$pos] )); then
      if (( bracket_color_size )); then
        _zsh_highlight_add_highlight $((pos - 1)) $pos bracket-level-$(( (levelpos[$pos] - 1) % bracket_color_size + 1 ))
      fi
    else
      _zsh_highlight_add_highlight $((pos - 1)) $pos bracket-error
    fi
  done

  if [[ $WIDGET != zle-line-finish ]]; then
    pos=$((CURSOR + 1))
    if (( $+levelpos[$pos] )) && (( $+matching[$pos] )); then
      local -i otherpos=$matching[$pos]
      _zsh_highlight_add_highlight $((otherpos - 1)) $otherpos cursor-matchingbracket
    fi
  fi
}

_zsh_highlight_brackets_match()
{
  case $BUFFER[$1] in
    \() [[ $BUFFER[$2] == \) ]];;
    \[) [[ $BUFFER[$2] == \] ]];;
    \{) [[ $BUFFER[$2] == \} ]];;
    *) false;;
  esac
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/cursor/cursor-highlighter.zsh
: ${ZSH_HIGHLIGHT_STYLES[cursor]:=standout}

_zsh_highlight_highlighter_cursor_predicate()
{
  [[ $WIDGET == zle-line-finish ]] || _zsh_highlight_cursor_moved
}

_zsh_highlight_highlighter_cursor_paint()
{
  [[ $WIDGET == zle-line-finish ]] && return

  _zsh_highlight_add_highlight $CURSOR $(( $CURSOR + 1 )) cursor
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/line/line-highlighter.zsh
: ${ZSH_HIGHLIGHT_STYLES[line]:=}

_zsh_highlight_highlighter_line_predicate()
{
  _zsh_highlight_buffer_modified
}

_zsh_highlight_highlighter_line_paint()
{
  _zsh_highlight_add_highlight 0 $#BUFFER line
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/main/main-highlighter.zsh
: ${ZSH_HIGHLIGHT_STYLES[default]:=none}
: ${ZSH_HIGHLIGHT_STYLES[unknown-token]:=fg=red,bold}
: ${ZSH_HIGHLIGHT_STYLES[reserved-word]:=fg=yellow}
: ${ZSH_HIGHLIGHT_STYLES[suffix-alias]:=fg=green,underline}
: ${ZSH_HIGHLIGHT_STYLES[global-alias]:=fg=cyan}
: ${ZSH_HIGHLIGHT_STYLES[precommand]:=fg=green,underline}
: ${ZSH_HIGHLIGHT_STYLES[commandseparator]:=none}
: ${ZSH_HIGHLIGHT_STYLES[autodirectory]:=fg=green,underline}
: ${ZSH_HIGHLIGHT_STYLES[path]:=underline}
: ${ZSH_HIGHLIGHT_STYLES[path_pathseparator]:=}
: ${ZSH_HIGHLIGHT_STYLES[path_prefix_pathseparator]:=}
: ${ZSH_HIGHLIGHT_STYLES[globbing]:=fg=blue}
: ${ZSH_HIGHLIGHT_STYLES[history-expansion]:=fg=blue}
: ${ZSH_HIGHLIGHT_STYLES[command-substitution]:=none}
: ${ZSH_HIGHLIGHT_STYLES[command-substitution-delimiter]:=fg=magenta}
: ${ZSH_HIGHLIGHT_STYLES[process-substitution]:=none}
: ${ZSH_HIGHLIGHT_STYLES[process-substitution-delimiter]:=fg=magenta}
: ${ZSH_HIGHLIGHT_STYLES[single-hyphen-option]:=none}
: ${ZSH_HIGHLIGHT_STYLES[double-hyphen-option]:=none}
: ${ZSH_HIGHLIGHT_STYLES[back-quoted-argument]:=none}
: ${ZSH_HIGHLIGHT_STYLES[back-quoted-argument-delimiter]:=fg=magenta}
: ${ZSH_HIGHLIGHT_STYLES[single-quoted-argument]:=fg=yellow}
: ${ZSH_HIGHLIGHT_STYLES[double-quoted-argument]:=fg=yellow}
: ${ZSH_HIGHLIGHT_STYLES[dollar-quoted-argument]:=fg=yellow}
: ${ZSH_HIGHLIGHT_STYLES[rc-quote]:=fg=cyan}
: ${ZSH_HIGHLIGHT_STYLES[dollar-double-quoted-argument]:=fg=cyan}
: ${ZSH_HIGHLIGHT_STYLES[back-double-quoted-argument]:=fg=cyan}
: ${ZSH_HIGHLIGHT_STYLES[back-dollar-quoted-argument]:=fg=cyan}
: ${ZSH_HIGHLIGHT_STYLES[assign]:=none}
: ${ZSH_HIGHLIGHT_STYLES[redirection]:=fg=yellow}
: ${ZSH_HIGHLIGHT_STYLES[comment]:=fg=black,bold}
: ${ZSH_HIGHLIGHT_STYLES[named-fd]:=none}
: ${ZSH_HIGHLIGHT_STYLES[numeric-fd]:=none}
: ${ZSH_HIGHLIGHT_STYLES[arg0]:=fg=green}

_zsh_highlight_highlighter_main_predicate()
{
  [[ $WIDGET == zle-line-finish ]] || _zsh_highlight_buffer_modified
}

_zsh_highlight_main_add_region_highlight() {
  integer start=$1 end=$2
  shift 2

  if (( $#in_alias )); then
    [[ $1 == unknown-token ]] && alias_style=unknown-token
    return
  fi
  if (( in_param )); then
    if [[ $1 == unknown-token ]]; then
      param_style=unknown-token
    fi
    if [[ -n $param_style ]]; then
      return
    fi
    param_style=$1
    return
  fi

  (( start += buf_offset ))
  (( end += buf_offset ))

  list_highlights+=($start $end $1)
}

_zsh_highlight_main_add_many_region_highlights() {
  for 1 2 3; do
    _zsh_highlight_main_add_region_highlight $1 $2 $3
  done
}

_zsh_highlight_main_calculate_fallback() {
  local -A fallback_of; fallback_of=(
      alias arg0
      suffix-alias arg0
      global-alias dollar-double-quoted-argument
      builtin arg0
      function arg0
      command arg0
      precommand arg0
      hashed-command arg0
      autodirectory arg0
      arg0_\* arg0

      path_prefix path
      path_pathseparator path
      path_prefix_pathseparator path_prefix

      single-quoted-argument{-unclosed,}
      double-quoted-argument{-unclosed,}
      dollar-quoted-argument{-unclosed,}
      back-quoted-argument{-unclosed,}

      command-substitution{-quoted,,-unquoted,}
      command-substitution-delimiter{-quoted,,-unquoted,}

      command-substitution{-delimiter,}
      process-substitution{-delimiter,}
      back-quoted-argument{-delimiter,}
  )
  local needle=$1 value
  reply=($1)
  while [[ -n ${value::=$fallback_of[(k)$needle]} ]]; do
    unset "fallback_of[$needle]"
    reply+=($value)
    needle=$value
  done
}

_zsh_highlight_main__type() {
  integer -r aliases_allowed=${2-1}
  integer may_cache=1

  if (( $+_zsh_highlight_main__command_type_cache )); then
    REPLY=$_zsh_highlight_main__command_type_cache[(e)$1]
    if [[ -n "$REPLY" ]]; then
      return
    fi
  fi

  if (( $#options_to_set )); then
    setopt localoptions $options_to_set;
  fi
  unset REPLY
  if zmodload -e zsh/parameter; then
    if (( $+aliases[(e)$1] )); then
      may_cache=0
    fi
    if (( ${+galiases[(e)$1]} )) && (( aliases_allowed )); then
      REPLY='global alias'
    elif (( $+aliases[(e)$1] )) && (( aliases_allowed )); then
      REPLY=alias
    elif [[ $1 == *.* && -n ${1%.*} ]] && (( $+saliases[(e)${1##*.}] )); then
      REPLY='suffix alias'
    elif (( $reswords[(Ie)$1] )); then
      REPLY=reserved
    elif (( $+functions[(e)$1] )); then
      REPLY=function
    elif (( $+builtins[(e)$1] )); then
      REPLY=builtin
    elif (( $+commands[(e)$1] )); then
      REPLY=command
    elif {  [[ $1 != */* ]] || is-at-least 5.3 } &&
         ! (builtin type -w -- "$1") >/dev/null 2>&1; then
      REPLY=none
    fi
  fi
  if ! (( $+REPLY )); then
    REPLY="${$(:; (( aliases_allowed )) || unalias -- "$1" 2>/dev/null; LC_ALL=C builtin type -w -- "$1" 2>/dev/null)##*: }"
    if [[ $REPLY == 'alias' ]]; then
      may_cache=0
    fi
  fi

  if (( may_cache )) && (( $+_zsh_highlight_main__command_type_cache )); then
    _zsh_highlight_main__command_type_cache[(e)$1]=$REPLY
  fi
  [[ -n $REPLY ]]
  return $?
}

_zsh_highlight_main__is_runnable() {
  if _zsh_highlight_main__type "$1"; then
    [[ $REPLY != none ]]
  else
    return 2
  fi
}

_zsh_highlight_main__is_redirection() {
  [[ $1 == (<0-9>|)(\<|\>)* ]] && [[ $1 != (\<|\>)$'\x28'* ]] && [[ $1 != *'<'*'-'*'>'* ]]
}

_zsh_highlight_main__resolve_alias() {
  if zmodload -e zsh/parameter; then
    REPLY=${aliases[$arg]}
  else
    REPLY="${"$(alias -- $arg)"#*=}"
  fi
}

_zsh_highlight_main__is_global_alias() {
  if zmodload -e zsh/parameter; then
    (( ${+galiases[$arg]} ))
  elif [[ $arg == '='* ]]; then
    return 1
  else
    alias -L -g -- "$1" >/dev/null
  fi
}

_zsh_highlight_main__stack_pop() {
  if [[ $braces_stack[1] == $1 ]]; then
    braces_stack=${braces_stack:1}
    if (( $+2 )); then
      style=$2
    fi
    return 0
  else
    style=unknown-token
    return 1
  fi
}

_zsh_highlight_highlighter_main_paint()
{
  setopt localoptions extendedglob

  if [[ $CONTEXT == (select|vared) ]]; then
    return
  fi

  typeset -a ZSH_HIGHLIGHT_TOKENS_COMMANDSEPARATOR
  typeset -a ZSH_HIGHLIGHT_TOKENS_CONTROL_FLOW
  local -a options_to_set reply
  local REPLY

  local flags_with_argument
  local flags_sans_argument
  local flags_solo
  local -A precommand_options
  precommand_options=(
    '-' ''
    'builtin' ''
    'command' :pvV
    'exec' a:cl
    'noglob' ''

    'doas' aCu:Lns
    'nice' n:
    'pkexec' ''
    'sudo' Cgprtu:AEHPSbilns:eKkVv
    'stdbuf' ioe:
    'eatmydata' ''
    'catchsegv' ''
    'nohup' ''
    'setsid' :wc
    'env' u:i
    'ionice' cn:t:pPu
    'strace' IbeaosXPpEuOS:ACdfhikqrtTvVxyDc
    'proxychains' f:q
    'torsocks' idq:upaP
    'torify' idq:upaP
    'ssh-agent' aEPt:csDd:k
    'tabbed' gnprtTuU:cdfhs:v
    'chronic' :ev
    'ifne' :n
    'grc' :se
    'cpulimit' elp:ivz
    'ktrace' fgpt:aBCcdiT
  )

  if [[ $zsyh_user_options[ignorebraces] == on || ${zsyh_user_options[ignoreclosebraces]:-off} == on ]]; then
    local right_brace_is_recognised_everywhere=false
  else
    local right_brace_is_recognised_everywhere=true
  fi

  if [[ $zsyh_user_options[pathdirs] == on ]]; then
    options_to_set+=( PATH_DIRS )
  fi

  ZSH_HIGHLIGHT_TOKENS_COMMANDSEPARATOR=(
    '|' '||' ';' '&' '&&'
    $'\n'
    '|&'
    '&!' '&|'
  )

  ZSH_HIGHLIGHT_TOKENS_CONTROL_FLOW=(
    $'\x7b'
    $'\x28'
    '()'
    'while'
    'until'
    'if'
    'then'
    'elif'
    'else'
    'do'
    'time'
    'coproc'
    '!'
  )

  if (( $+X_ZSH_HIGHLIGHT_DIRS_BLACKLIST )); then
    print >&2 'zsh-syntax-highlighting: X_ZSH_HIGHLIGHT_DIRS_BLACKLIST is deprecated. Please use ZSH_HIGHLIGHT_DIRS_BLACKLIST.'
    ZSH_HIGHLIGHT_DIRS_BLACKLIST=($X_ZSH_HIGHLIGHT_DIRS_BLACKLIST)
    unset X_ZSH_HIGHLIGHT_DIRS_BLACKLIST
  fi

  _zsh_highlight_main_highlighter_highlight_list -$#PREBUFFER '' 1 "$PREBUFFER$BUFFER"

  local start end_ style
  for start end_ style in $reply; do
    (( start >= end_ )) && { print -r -- >&2 "zsh-syntax-highlighting: BUG: _zsh_highlight_highlighter_main_paint: start($start) >= end($end_)"; return }
    (( end_ <= 0 )) && continue
    (( start < 0 )) && start=0
    _zsh_highlight_main_calculate_fallback $style
    _zsh_highlight_add_highlight $start $end_ $reply
  done
}

_zsh_highlight_main_highlighter__try_expand_parameter()
{
  local arg="$1"
  unset reply
  {
    {
      local -a match mbegin mend
      local MATCH; integer MBEGIN MEND
      local parameter_name
      local -a words
      if [[ $arg[1] != '$' ]]; then
        return 1
      fi
      if [[ ${arg[2]} == '{' ]] && [[ ${arg[-1]} == '}' ]]; then
        parameter_name=${${arg:2}%?}
      else
        parameter_name=${arg:1}
      fi
      if [[ $res == none ]] &&
         [[ ${parameter_name} =~ ^${~parameter_name_pattern}$ ]] &&
         [[ ${(tP)MATCH} != *special* ]]
      then
        case ${(tP)MATCH} in
          (*array*|*assoc*)
            words=( ${(P)MATCH} )
            ;;
          ("")
            words=( )
            ;;
          (*)
            if [[ $zsyh_user_options[shwordsplit] == on ]]; then
              words=( ${(P)=MATCH} )
            else
              words=( ${(P)MATCH} )
            fi
            ;;
        esac
        reply=( "${words[@]}" )
      else
        return 1
      fi
    }
  }
}

_zsh_highlight_main_highlighter_highlight_list()
{
  integer start_pos end_pos=0 buf_offset=$1 has_end=$3
  local alias_style param_style last_arg arg buf=$4 highlight_glob=true saw_assignment=false style
  local in_array_assignment=false
  integer in_param=0 len=$#buf
  local -a in_alias match mbegin mend list_highlights
  local -A seen_alias
  readonly parameter_name_pattern='([A-Za-z_][A-Za-z0-9_]*|[0-9]+)'
  list_highlights=()

  local braces_stack=$2

  local this_word next_word=':start::start_of_pipeline:'
  integer in_redirection
  local proc_buf="$buf"
  local -a args
  if [[ $zsyh_user_options[interactivecomments] == on ]]; then
    args=(${(zZ+c+)buf})
  else
    args=(${(z)buf})
  fi

  if [[ $braces_stack == 'S' ]] && (( $+args[3] && ! $+args[4] )) && [[ $args[3] == $'\x29' ]] &&
     [[ $args[1] == *'<'* ]] && _zsh_highlight_main__is_redirection $args[1]; then
    highlight_glob=false
  fi

  while (( $#args )); do
    last_arg=$arg
    arg=$args[1]
    shift args
    if (( $#in_alias )); then
      (( in_alias[1]-- ))
      in_alias=($in_alias[$in_alias[(i)<1->],-1])
      if (( $#in_alias == 0 )); then
        seen_alias=()
        _zsh_highlight_main_add_region_highlight $start_pos $end_pos $alias_style
      else
        (){
          local alias_name
          for alias_name in ${(k)seen_alias[(R)<$#in_alias->]}; do
            seen_alias=("${(@kv)seen_alias[(I)^$alias_name]}")
          done
        }
      fi
    fi
    if (( in_param )); then
      (( in_param-- ))
      if (( in_param == 0 )); then
        _zsh_highlight_main_add_region_highlight $start_pos $end_pos $param_style
        param_style=""
      fi
    fi

    if (( in_redirection == 0 )); then
      this_word=$next_word
      next_word=':regular:'
    elif (( !in_param )); then
      (( --in_redirection ))
    fi

    style=unknown-token
    if [[ $this_word == *':start:'* ]]; then
      in_array_assignment=false
      if [[ $arg == 'noglob' ]]; then
        highlight_glob=false
      fi
    fi

    if (( $#in_alias == 0 && in_param == 0 )); then
      [[ "$proc_buf" = (#b)(#s)(''([ $'\t']|[\\]$'\n')#)(?|)* ]]
      integer offset="${#match[1]}"
      (( start_pos = end_pos + offset ))
      (( end_pos = start_pos + $#arg ))

      [[ $arg == ';' && ${match[3]} == $'\n' ]] && arg=$'\n'

      proc_buf="${proc_buf[offset + $#arg + 1,len]}"
    fi

    if [[ $zsyh_user_options[interactivecomments] == on && $arg[1] == $histchars[3] ]]; then
      if [[ $this_word == *(':regular:'|':start:')* ]]; then
        style=comment
      else
        style=unknown-token
      fi
      _zsh_highlight_main_add_region_highlight $start_pos $end_pos $style
      in_redirection=1
      continue
    fi

    if [[ $this_word == *':start:'* ]] && ! (( in_redirection )); then
      _zsh_highlight_main__type "$arg" "$(( ! ${+seen_alias[$arg]} ))"
      local res="$REPLY"
      if [[ $res == "alias" ]]; then
        if [[ $arg == ?*=* ]]; then
          _zsh_highlight_main_add_region_highlight $start_pos $end_pos unknown-token
          continue
        fi
        seen_alias[$arg]=$#in_alias
        _zsh_highlight_main__resolve_alias $arg
        local -a alias_args
        if [[ $zsyh_user_options[interactivecomments] == on ]]; then
          alias_args=(${(zZ+c+)REPLY})
        else
          alias_args=(${(z)REPLY})
        fi
        args=( $alias_args $args )
        if (( $#in_alias == 0 )); then
          alias_style=alias
        else
          (( in_alias[1]-- ))
        fi
        in_alias=( $(($#alias_args + 1)) $in_alias )
        (( in_redirection++ ))
        continue
      else
        _zsh_highlight_main_highlighter_expand_path $arg
        _zsh_highlight_main__type "$REPLY" 0
        res="$REPLY"
      fi
    fi

    if _zsh_highlight_main__is_redirection $arg ; then
      if (( in_redirection == 1 )); then
        _zsh_highlight_main_add_region_highlight $start_pos $end_pos unknown-token
      else
        in_redirection=2
        _zsh_highlight_main_add_region_highlight $start_pos $end_pos redirection
      fi
      continue
    elif [[ $arg == '{'${~parameter_name_pattern}'}' ]] && _zsh_highlight_main__is_redirection $args[1]; then
      in_redirection=3
      _zsh_highlight_main_add_region_highlight $start_pos $end_pos named-fd
      continue
    fi

    if (( ! in_param )) && _zsh_highlight_main_highlighter__try_expand_parameter "$arg"; then
      () {
        local -a words; words=( "${reply[@]}" )
        if (( $#words == 0 )) && (( ! in_redirection )); then
          (( ++in_redirection ))
          _zsh_highlight_main_add_region_highlight $start_pos $end_pos comment
          continue
        else
          (( in_param = 1 + $#words ))
          args=( $words $args )
          arg=$args[1]
          _zsh_highlight_main__type "$arg" 0
          res=$REPLY
        fi
      }
    fi

    if (( ! in_redirection )); then
      if [[ $this_word == *':sudo_opt:'* ]]; then
        if [[ -n $flags_with_argument ]] &&
           {
             if [[ -n $flags_sans_argument ]]
             then [[ $arg == '-'[$flags_sans_argument]#[$flags_with_argument] ]]
             else [[ $arg == '-'[$flags_with_argument] ]]
             fi
           } then
          this_word=${this_word//:start:/}
          next_word=':sudo_arg:'
        elif [[ -n $flags_with_argument ]] &&
             {
               if [[ -n $flags_sans_argument ]]
               then [[ $arg == '-'[$flags_sans_argument]#[$flags_with_argument]* ]]
               else [[ $arg == '-'[$flags_with_argument]* ]]
               fi
             } then
          this_word=${this_word//:start:/}
          next_word+=':start:'
          next_word+=':sudo_opt:'
        elif [[ -n $flags_sans_argument ]] &&
             [[ $arg == '-'[$flags_sans_argument]# ]]; then
          this_word=':sudo_opt:'
          next_word+=':start:'
          next_word+=':sudo_opt:'
        elif [[ -n $flags_solo ]] &&
             {
               if [[ -n $flags_sans_argument ]]
               then [[ $arg == '-'[$flags_sans_argument]#[$flags_solo]* ]]
               else [[ $arg == '-'[$flags_solo]* ]]
               fi
             } then
          this_word=':sudo_opt:'
          next_word=':regular:'
        elif [[ $arg == '-'* ]]; then
          this_word=':sudo_opt:'
          next_word+=':start:'
          next_word+=':sudo_opt:'
        else
          this_word=${this_word//:sudo_opt:/}
        fi
      elif [[ $this_word == *':sudo_arg:'* ]]; then
        next_word+=':sudo_opt:'
        next_word+=':start:'
      fi
    fi

    if [[ -n ${(M)ZSH_HIGHLIGHT_TOKENS_COMMANDSEPARATOR:#"$arg"} ]] &&
       [[ $braces_stack != *T* || $arg != ('||'|'&&') ]]; then
      if _zsh_highlight_main__stack_pop T || _zsh_highlight_main__stack_pop Q; then
        style=unknown-token
      elif $in_array_assignment; then
        case $arg in
          ($'\n') style=commandseparator;;
          (';') style=unknown-token;;
          (*) style=unknown-token;;
        esac
      elif [[ $this_word == *':regular:'* ]]; then
        style=commandseparator
      elif [[ $this_word == *':start:'* ]] && [[ $arg == $'\n' ]]; then
        style=commandseparator
      elif [[ $this_word == *':start:'* ]] && [[ $arg == ';' ]] && (( $#in_alias )); then
        style=commandseparator
      else
        style=unknown-token
      fi

      if [[ $arg == $'\n' ]] && $in_array_assignment; then
        next_word=':regular:'
      elif [[ $arg == ';' ]] && $in_array_assignment; then
        next_word=':regular:'
      else
        next_word=':start:'
        highlight_glob=true
        saw_assignment=false
        (){
          local alias_name
          for alias_name in ${(k)seen_alias[(R)<$#in_alias->]}; do
            seen_alias=("${(@kv)seen_alias[(I)^$alias_name]}")
          done
        }
        if [[ $arg != '|' && $arg != '|&' ]]; then
          next_word+=':start_of_pipeline:'
        fi
      fi

    elif ! (( in_redirection)) && [[ $this_word == *':always:'* && $arg == 'always' ]]; then
      style=reserved-word
      highlight_glob=true
      saw_assignment=false
      next_word=':start::start_of_pipeline:'
    elif ! (( in_redirection)) && [[ $this_word == *':start:'* ]]; then
      if (( ${+precommand_options[$arg]} )) && _zsh_highlight_main__is_runnable $arg; then
        style=precommand
        () {
          set -- "${(@s.:.)precommand_options[$arg]}"
          flags_with_argument=$1
          flags_sans_argument=$2
          flags_solo=$3
        }
        next_word=${next_word//:regular:/}
        next_word+=':sudo_opt:'
        next_word+=':start:'
        if [[ $arg == 'exec' || $arg == 'env' ]]; then
          next_word+=':regular:'
        fi
      else
        case $res in
          (reserved)
                        style=reserved-word
                        case $arg in
                          (time|nocorrect)
                            next_word=${next_word//:regular:/}
                            next_word+=':start:'
                            ;;
                          ($'\x7b')
                            braces_stack='Y'"$braces_stack"
                            ;;
                          ($'\x7d')
                            _zsh_highlight_main__stack_pop 'Y' reserved-word
                            if [[ $style == reserved-word ]]; then
                              next_word+=':always:'
                            fi
                            ;;
                          ($'\x5b\x5b')
                            braces_stack='T'"$braces_stack"
                            ;;
                          ('do')
                            braces_stack='D'"$braces_stack"
                            ;;
                          ('done')
                            _zsh_highlight_main__stack_pop 'D' reserved-word
                            ;;
                          ('if')
                            braces_stack=':?'"$braces_stack"
                            ;;
                          ('then')
                            _zsh_highlight_main__stack_pop ':' reserved-word
                            ;;
                          ('elif')
                            if [[ ${braces_stack[1]} == '?' ]]; then
                              braces_stack=':'"$braces_stack"
                            else
                              style=unknown-token
                            fi
                            ;;
                          ('else')
                            if [[ ${braces_stack[1]} == '?' ]]; then
                              :
                            else
                              style=unknown-token
                            fi
                            ;;
                          ('fi')
                            _zsh_highlight_main__stack_pop '?'
                            ;;
                          ('foreach')
                            braces_stack='$'"$braces_stack"
                            ;;
                          ('end')
                            _zsh_highlight_main__stack_pop '$' reserved-word
                            ;;
                          ('repeat')
                            in_redirection=2
                            this_word=':start::regular:'
                            ;;
                          ('!')
                            if [[ $this_word != *':start_of_pipeline:'* ]]; then
                              style=unknown-token
                            else
                            fi
                            ;;
                        esac
                        if $saw_assignment && [[ $style != unknown-token ]]; then
                          style=unknown-token
                        fi
                        ;;
          ('suffix alias')
                        style=suffix-alias
                        ;;
          ('global alias')
                        style=global-alias
                        ;;
          (alias)       :;;
          (builtin)     style=builtin
                        [[ $arg == $'\x5b' ]] && braces_stack='Q'"$braces_stack"
                        ;;
          (function)    style=function;;
          (command)     style=command;;
          (hashed)      style=hashed-command;;
          (none)        if (( ! in_param )) && _zsh_highlight_main_highlighter_check_assign; then
                          _zsh_highlight_main_add_region_highlight $start_pos $end_pos assign
                          local i=$(( arg[(i)=] + 1 ))
                          saw_assignment=true
                          if [[ $arg[i] == '(' ]]; then
                            in_array_assignment=true
                            _zsh_highlight_main_add_region_highlight start_pos+i-1 start_pos+i reserved-word
                          else
                            next_word+=':start:'
                            if (( i <= $#arg )); then
                              () {
                                local highlight_glob=false
                                [[ $zsyh_user_options[globassign] == on ]] && highlight_glob=true
                                _zsh_highlight_main_highlighter_highlight_argument $i
                              }
                            fi
                          fi
                          continue
                        elif (( ! in_param )) &&
                             [[ $arg[0,1] = $histchars[0,1] ]] && (( $#arg[0,2] == 2 )); then
                          style=history-expansion
                        elif (( ! in_param )) &&
                             [[ $arg[0,1] == $histchars[2,2] ]]; then
                          style=history-expansion
                        elif (( ! in_param )) &&
                             ! $saw_assignment &&
                             [[ $arg[1,2] == '((' ]]; then
                          _zsh_highlight_main_add_region_highlight $start_pos $((start_pos + 2)) reserved-word
                          if [[ $arg[-2,-1] == '))' ]]; then
                            _zsh_highlight_main_add_region_highlight $((end_pos - 2)) $end_pos reserved-word
                          fi
                          continue
                        elif (( ! in_param )) &&
                             [[ $arg == '()' ]]; then
                          style=reserved-word
                        elif (( ! in_param )) &&
                             ! $saw_assignment &&
                             [[ $arg == $'\x28' ]]; then
                          style=reserved-word
                          braces_stack='R'"$braces_stack"
                        elif (( ! in_param )) &&
                             [[ $arg == $'\x29' ]]; then
                          if _zsh_highlight_main__stack_pop 'S'; then
                            REPLY=$start_pos
                            reply=($list_highlights)
                            return 0
                          fi
                          _zsh_highlight_main__stack_pop 'R' reserved-word
                        else
                          if _zsh_highlight_main_highlighter_check_path $arg 1; then
                            style=$REPLY
                          else
                            style=unknown-token
                          fi
                        fi
                        ;;
          (*)           _zsh_highlight_main_add_region_highlight $start_pos $end_pos arg0_$res
                        continue
                        ;;
        esac
      fi
      if [[ -n ${(M)ZSH_HIGHLIGHT_TOKENS_CONTROL_FLOW:#"$arg"} ]]; then
        next_word=':start::start_of_pipeline:'
      fi
    elif _zsh_highlight_main__is_global_alias "$arg"; then
      style=global-alias
    else
      case $arg in
        ($'\x29')
                  if $in_array_assignment; then
                    _zsh_highlight_main_add_region_highlight $start_pos $end_pos assign
                    _zsh_highlight_main_add_region_highlight $start_pos $end_pos reserved-word
                    in_array_assignment=false
                    next_word+=':start:'
                    continue
                  elif (( in_redirection )); then
                    style=unknown-token
                  else
                    if _zsh_highlight_main__stack_pop 'S'; then
                      REPLY=$start_pos
                      reply=($list_highlights)
                      return 0
                    fi
                    _zsh_highlight_main__stack_pop 'R' reserved-word
                  fi
                  ;;
        ($'\x28\x29')
                  if (( in_redirection )) || $in_array_assignment; then
                    style=unknown-token
                  else
                    if [[ $zsyh_user_options[multifuncdef] == on ]] || false
                    then
                      next_word+=':start::start_of_pipeline:'
                    fi
                    style=reserved-word
                  fi
                  ;;
        (*)       if false; then
                  elif [[ $arg = $'\x7d' ]] && $right_brace_is_recognised_everywhere; then
                    if (( in_redirection )) || $in_array_assignment; then
                      style=unknown-token
                    else
                      _zsh_highlight_main__stack_pop 'Y' reserved-word
                      if [[ $style == reserved-word ]]; then
                        next_word+=':always:'
                      fi
                    fi
                  elif [[ $arg[0,1] = $histchars[0,1] ]] && (( $#arg[0,2] == 2 )); then
                    style=history-expansion
                  elif [[ $arg == $'\x5d\x5d' ]] && _zsh_highlight_main__stack_pop 'T' reserved-word; then
                    :
                  elif [[ $arg == $'\x5d' ]] && _zsh_highlight_main__stack_pop 'Q' builtin; then
                    :
                  else
                    _zsh_highlight_main_highlighter_highlight_argument 1 $(( 1 != in_redirection ))
                    continue
                  fi
                  ;;
      esac
    fi
    _zsh_highlight_main_add_region_highlight $start_pos $end_pos $style
  done
  (( $#in_alias )) && in_alias=() _zsh_highlight_main_add_region_highlight $start_pos $end_pos $alias_style
  (( in_param == 1 )) && in_param=0 _zsh_highlight_main_add_region_highlight $start_pos $end_pos $param_style
  [[ "$proc_buf" = (#b)(#s)(([[:space:]]|\\$'\n')#) ]]
  REPLY=$(( end_pos + ${#match[1]} - 1 ))
  reply=($list_highlights)
  return $(( $#braces_stack > 0 ))
}

_zsh_highlight_main_highlighter_check_assign()
{
    setopt localoptions extended_glob
    [[ $arg == [[:alpha:]_][[:alnum:]_]#(|\[*\])(|[+])=* ]] ||
      [[ $arg == [0-9]##(|[+])=* ]]
}

_zsh_highlight_main_highlighter_highlight_path_separators()
{
  local pos style_pathsep
  style_pathsep=$1_pathseparator
  reply=()
  [[ -z "$ZSH_HIGHLIGHT_STYLES[$style_pathsep]" || "$ZSH_HIGHLIGHT_STYLES[$1]" == "$ZSH_HIGHLIGHT_STYLES[$style_pathsep]" ]] && return 0
  for (( pos = start_pos; $pos <= end_pos; pos++ )) ; do
    if [[ $BUFFER[pos] == / ]]; then
      reply+=($((pos - 1)) $pos $style_pathsep)
    fi
  done
}

_zsh_highlight_main_highlighter_check_path()
{
  _zsh_highlight_main_highlighter_expand_path "$1"
  local expanded_path="$REPLY" tmp_path
  integer in_command_position=$2

  if [[ $zsyh_user_options[autocd] == on ]]; then
    integer autocd=1
  else
    integer autocd=0
  fi

  if (( in_command_position )); then
    REPLY=arg0
  else
    REPLY=path
  fi

  if [[ ${1[1]} == '=' && $1 == ??* && ${1[2]} != $'\x28' && $zsyh_user_options[equals] == 'on' && $expanded_path[1] != '/' ]]; then
    REPLY=unknown-token
    return 0
  fi

  [[ -z $expanded_path ]] && return 1

  if [[ $expanded_path[1] == / ]]; then
    tmp_path=$expanded_path
  else
    tmp_path=$PWD/$expanded_path
  fi
  tmp_path=$tmp_path:a

  while [[ $tmp_path != / ]]; do
    [[ -n ${(M)ZSH_HIGHLIGHT_DIRS_BLACKLIST:#$tmp_path} ]] && return 1
    tmp_path=$tmp_path:h
  done

  if (( in_command_position )); then
    if [[ -x $expanded_path ]]; then
      if (( autocd )); then
        if [[ -d $expanded_path ]]; then
          REPLY=autodirectory
        fi
        return 0
      elif [[ ! -d $expanded_path ]]; then
        return 0
      fi
    fi
  else
    if [[ -L $expanded_path || -e $expanded_path ]]; then
      return 0
    fi
  fi

  if [[ $expanded_path != /* ]] && (( autocd || ! in_command_position )); then
    local cdpath_dir
    for cdpath_dir in $cdpath ; do
      if [[ -d "$cdpath_dir/$expanded_path" && -x "$cdpath_dir/$expanded_path" ]]; then
        if (( in_command_position && autocd )); then
          REPLY=autodirectory
        fi
        return 0
      fi
    done
  fi

  [[ ! -d ${expanded_path:h} ]] && return 1

  if (( has_end && (len == end_pos) )) &&
     (( ! $#in_alias )) &&
     [[ $WIDGET != zle-line-finish ]]; then
    local -a tmp
    if (( in_command_position )); then
      tmp=( ${expanded_path}*(N-*,N-/) )
    else
      tmp=( ${expanded_path}*(N) )
    fi
    (( ${+tmp[1]} )) && REPLY=path_prefix && return 0
  fi

  return 1
}

_zsh_highlight_main_highlighter_highlight_argument()
{
  local base_style=default i=$1 option_eligible=${2:-1} path_eligible=1 ret start style
  local -a highlights

  local -a match mbegin mend
  local MATCH; integer MBEGIN MEND

  case "$arg[i]" in
    '%')
      if [[ $arg[i+1] == '?' ]]; then
        (( i += 2 ))
      fi
      ;;
    '-')
      if (( option_eligible )); then
        if [[ $arg[i+1] == - ]]; then
          base_style=double-hyphen-option
        else
          base_style=single-hyphen-option
        fi
        path_eligible=0
      fi
      ;;
    '=')
      if [[ $arg[i+1] == $'\x28' ]]; then
        (( i += 2 ))
        _zsh_highlight_main_highlighter_highlight_list $(( start_pos + i - 1 )) S $has_end $arg[i,-1]
        ret=$?
        (( i += REPLY ))
        highlights+=(
          $(( start_pos + $1 - 1 )) $(( start_pos + i )) process-substitution
          $(( start_pos + $1 - 1 )) $(( start_pos + $1 + 1 )) process-substitution-delimiter
          $reply
        )
        if (( ret == 0 )); then
          highlights+=($(( start_pos + i - 1 )) $(( start_pos + i )) process-substitution-delimiter)
        fi
      fi
  esac

  (( --i ))
  while (( ++i <= $#arg )); do
    i=${arg[(ib.i.)[\\\'\"\`\$\<\>\*\?]]}
    case "$arg[$i]" in
      "") break;;
      "\\") (( i += 1 )); continue;;
      "'")
        _zsh_highlight_main_highlighter_highlight_single_quote $i
        (( i = REPLY ))
        highlights+=($reply)
        ;;
      '"')
        _zsh_highlight_main_highlighter_highlight_double_quote $i
        (( i = REPLY ))
        highlights+=($reply)
        ;;
      '`')
        _zsh_highlight_main_highlighter_highlight_backtick $i
        (( i = REPLY ))
        highlights+=($reply)
        ;;
      '$')
        if [[ $arg[i+1] != "'" ]]; then
          path_eligible=0
        fi
        if [[ $arg[i+1] == "'" ]]; then
          _zsh_highlight_main_highlighter_highlight_dollar_quote $i
          (( i = REPLY ))
          highlights+=($reply)
          continue
        elif [[ $arg[i+1] == $'\x28' ]]; then
          if [[ $arg[i+2] == $'\x28' ]] && _zsh_highlight_main_highlighter_highlight_arithmetic $i; then
            (( i = REPLY ))
            highlights+=($reply)
            continue
          fi
          start=$i
          (( i += 2 ))
          _zsh_highlight_main_highlighter_highlight_list $(( start_pos + i - 1 )) S $has_end $arg[i,-1]
          ret=$?
          (( i += REPLY ))
          highlights+=(
            $(( start_pos + start - 1)) $(( start_pos + i )) command-substitution-unquoted
            $(( start_pos + start - 1)) $(( start_pos + start + 1)) command-substitution-delimiter-unquoted
            $reply
          )
          if (( ret == 0 )); then
            highlights+=($(( start_pos + i - 1)) $(( start_pos + i )) command-substitution-delimiter-unquoted)
          fi
          continue
        fi
        while [[ $arg[i+1] == [=~#+'^'] ]]; do
          (( i += 1 ))
        done
        if [[ $arg[i+1] == [*@#?$!-] ]]; then
          (( i += 1 ))
        fi;;
      [\<\>])
        if [[ $arg[i+1] == $'\x28' ]]; then
          start=$i
          (( i += 2 ))
          _zsh_highlight_main_highlighter_highlight_list $(( start_pos + i - 1 )) S $has_end $arg[i,-1]
          ret=$?
          (( i += REPLY ))
          highlights+=(
            $(( start_pos + start - 1)) $(( start_pos + i )) process-substitution
            $(( start_pos + start - 1)) $(( start_pos + start + 1 )) process-substitution-delimiter
            $reply
          )
          if (( ret == 0 )); then
            highlights+=($(( start_pos + i - 1)) $(( start_pos + i )) process-substitution-delimiter)
          fi
          continue
        fi
        ;|
      *)
        if $highlight_glob &&
           [[ $zsyh_user_options[multios] == on || $in_redirection -eq 0 ]] &&
           [[ ${arg[$i]} =~ ^[*?] || ${arg:$i-1} =~ ^\<[0-9]*-[0-9]*\> ]]; then
          highlights+=($(( start_pos + i - 1 )) $(( start_pos + i + $#MATCH - 1)) globbing)
          (( i += $#MATCH - 1 ))
          path_eligible=0
        else
          continue
        fi
        ;;
    esac
  done

  if (( path_eligible )); then
    if (( in_redirection )) && [[ $last_arg == *['<>']['&'] && $arg[$1,-1] == (<0->|p|-) ]]; then
      if [[ $arg[$1,-1] == (p|-) ]]; then
        base_style=redirection
      else
        base_style=numeric-fd
      fi
    elif _zsh_highlight_main_highlighter_check_path $arg[$1,-1] 0; then
      base_style=$REPLY
      _zsh_highlight_main_highlighter_highlight_path_separators $base_style
      highlights+=($reply)
    fi
  fi

  highlights=($(( start_pos + $1 - 1 )) $end_pos $base_style $highlights)
  _zsh_highlight_main_add_many_region_highlights $highlights
}

_zsh_highlight_main_highlighter_highlight_single_quote()
{
  local arg1=$1 i q=\' style
  i=$arg[(ib:arg1+1:)$q]
  reply=()

  if [[ $zsyh_user_options[rcquotes] == on ]]; then
    while [[ $arg[i+1] == "'" ]]; do
      reply+=($(( start_pos + i - 1 )) $(( start_pos + i + 1 )) rc-quote)
      (( i++ ))
      i=$arg[(ib:i+1:)$q]
    done
  fi

  if [[ $arg[i] == "'" ]]; then
    style=single-quoted-argument
  else
    (( i-- ))
    style=single-quoted-argument-unclosed
  fi
  reply=($(( start_pos + arg1 - 1 )) $(( start_pos + i )) $style $reply)
  REPLY=$i
}

_zsh_highlight_main_highlighter_highlight_double_quote()
{
  local -a breaks match mbegin mend saved_reply
  local MATCH; integer last_break=$(( start_pos + $1 - 1 )) MBEGIN MEND
  local i j k ret style
  reply=()

  for (( i = $1 + 1 ; i <= $#arg ; i += 1 )) ; do
    (( j = i + start_pos - 1 ))
    (( k = j + 1 ))
    case "$arg[$i]" in
      ('"') break;;
      ('`') saved_reply=($reply)
            _zsh_highlight_main_highlighter_highlight_backtick $i
            (( i = REPLY ))
            reply=($saved_reply $reply)
            continue
            ;;
      ('$') style=dollar-double-quoted-argument
            if [[ ${arg:$i} =~ ^([A-Za-z_][A-Za-z0-9_]*|[0-9]+) ]] ; then
              (( k += $#MATCH ))
              (( i += $#MATCH ))
            elif [[ ${arg:$i} =~ ^[{]([A-Za-z_][A-Za-z0-9_]*|[0-9]+)[}] ]] ; then
              (( k += $#MATCH ))
              (( i += $#MATCH ))
            elif [[ $arg[i+1] == '$' ]]; then
              (( k += 1 ))
              (( i += 1 ))
            elif [[ $arg[i+1] == [-#*@?] ]]; then
              (( k += 1 ))
              (( i += 1 ))
            elif [[ $arg[i+1] == $'\x28' ]]; then
              saved_reply=($reply)
              if [[ $arg[i+2] == $'\x28' ]] && _zsh_highlight_main_highlighter_highlight_arithmetic $i; then
                (( i = REPLY ))
                reply=($saved_reply $reply)
                continue
              fi

              breaks+=( $last_break $(( start_pos + i - 1 )) )
              (( i += 2 ))
              _zsh_highlight_main_highlighter_highlight_list $(( start_pos + i - 1 )) S $has_end $arg[i,-1]
              ret=$?
              (( i += REPLY ))
              last_break=$(( start_pos + i ))
              reply=(
                $saved_reply
                $j $(( start_pos + i )) command-substitution-quoted
                $j $(( j + 2 )) command-substitution-delimiter-quoted
                $reply
              )
              if (( ret == 0 )); then
                reply+=($(( start_pos + i - 1 )) $(( start_pos + i )) command-substitution-delimiter-quoted)
              fi
              continue
            else
              continue
            fi
            ;;
      "\\") style=back-double-quoted-argument
            if [[ \\\`\"\$${histchars[1]} == *$arg[$i+1]* ]]; then
              (( k += 1 ))
              (( i += 1 ))
            else
              continue
            fi
            ;;
      ($histchars[1])
            if [[ $arg[i+1] != ('='|$'\x28'|$'\x7b'|[[:blank:]]) ]]; then
              style=history-expansion
            else
              continue
            fi
            ;;
      *) continue ;;
    esac
    reply+=($j $k $style)
  done

  if [[ $arg[i] == '"' ]]; then
    style=double-quoted-argument
  else
    (( i-- ))
    style=double-quoted-argument-unclosed
  fi
  (( last_break != start_pos + i )) && breaks+=( $last_break $(( start_pos + i )) )
  saved_reply=($reply)
  reply=()
  for 1 2 in $breaks; do
    (( $1 != $2 )) && reply+=($1 $2 $style)
  done
  reply+=($saved_reply)
  REPLY=$i
}

_zsh_highlight_main_highlighter_highlight_dollar_quote()
{
  local -a match mbegin mend
  local MATCH; integer MBEGIN MEND
  local i j k style
  local AA
  integer c
  reply=()

  for (( i = $1 + 2 ; i <= $#arg ; i += 1 )) ; do
    (( j = i + start_pos - 1 ))
    (( k = j + 1 ))
    case "$arg[$i]" in
      "'") break;;
      "\\") style=back-dollar-quoted-argument
            for (( c = i + 1 ; c <= $#arg ; c += 1 )); do
              [[ "$arg[$c]" != ([0-9xXuUa-fA-F]) ]] && break
            done
            AA=$arg[$i+1,$c-1]
            if [[    "$AA" =~ "^(x|X)[0-9a-fA-F]{1,2}"
                  || "$AA" =~ "^[0-7]{1,3}"
                  || "$AA" =~ "^u[0-9a-fA-F]{1,4}"
                  || "$AA" =~ "^U[0-9a-fA-F]{1,8}"
               ]]; then
              (( k += $#MATCH ))
              (( i += $#MATCH ))
            else
              if (( $#arg > $i+1 )) && [[ $arg[$i+1] == [xXuU] ]]; then
                style=unknown-token
              fi
              (( k += 1 ))
              (( i += 1 ))
            fi
            ;;
      *) continue ;;
    esac
    reply+=($j $k $style)
  done

  if [[ $arg[i] == "'" ]]; then
    style=dollar-quoted-argument
  else
    (( i-- ))
    style=dollar-quoted-argument-unclosed
  fi
  reply=($(( start_pos + $1 - 1 )) $(( start_pos + i )) $style $reply)
  REPLY=$i
}

_zsh_highlight_main_highlighter_highlight_backtick()
{
  local buf highlight style=back-quoted-argument-unclosed style_end
  local -i arg1=$1 end_ i=$1 last offset=0 start subshell_has_end=0
  local -a highlight_zone highlights offsets
  reply=()

  last=$(( arg1 + 1 ))
  while i=$arg[(ib:i+1:)[\\\\\`]]; do
    if (( i > $#arg )); then
      buf=$buf$arg[last,i]
      offsets[i-arg1-offset]=''
      (( i-- ))
      subshell_has_end=$(( has_end && (start_pos + i == len) ))
      break
    fi

    if [[ $arg[i] == '\' ]]; then
      (( i++ ))
      if [[ $arg[i] == ('$'|'`'|'\') ]]; then
        buf=$buf$arg[last,i-2]
        (( offset++ ))
        offsets[i-arg1-offset]=$offset
      else
        buf=$buf$arg[last,i-1]
      fi
    else
      style=back-quoted-argument
      style_end=back-quoted-argument-delimiter
      buf=$buf$arg[last,i-1]
      offsets[i-arg1-offset]=''
      break
    fi
    last=$i
  done

  _zsh_highlight_main_highlighter_highlight_list 0 '' $subshell_has_end $buf

  for start end_ highlight in $reply; do
    start=$(( start_pos + arg1 + start + offsets[(Rb:start:)?*] ))
    end_=$(( start_pos + arg1 + end_ + offsets[(Rb:end_:)?*] ))
    highlights+=($start $end_ $highlight)
    if [[ $highlight == back-quoted-argument-unclosed && $style == back-quoted-argument ]]; then
      style_end=unknown-token
    fi
  done

  reply=(
    $(( start_pos + arg1 - 1 )) $(( start_pos + i )) $style
    $(( start_pos + arg1 - 1 )) $(( start_pos + arg1 )) back-quoted-argument-delimiter
    $highlights
  )
  if (( $#style_end )); then
    reply+=($(( start_pos + i - 1)) $(( start_pos + i )) $style_end)
  fi
  REPLY=$i
}

_zsh_highlight_main_highlighter_highlight_arithmetic()
{
  local -a saved_reply
  local style
  integer i j k paren_depth ret
  reply=()

  for (( i = $1 + 3 ; i <= end_pos - start_pos ; i += 1 )) ; do
    (( j = i + start_pos - 1 ))
    (( k = j + 1 ))
    case "$arg[$i]" in
      [\'\"\\@{}])
        style=unknown-token
        ;;
      '(')
        (( paren_depth++ ))
        continue
        ;;
      ')')
        if (( paren_depth )); then
          (( paren_depth-- ))
          continue
        fi
        [[ $arg[i+1] == ')' ]] && { (( i++ )); break; }
        (( has_end && (len == k) )) && break
        return 1
        ;;
      '`')
        saved_reply=($reply)
        _zsh_highlight_main_highlighter_highlight_backtick $i
        (( i = REPLY ))
        reply=($saved_reply $reply)
        continue
        ;;
      '$' )
        if [[ $arg[i+1] == $'\x28' ]]; then
          saved_reply=($reply)
          if [[ $arg[i+2] == $'\x28' ]] && _zsh_highlight_main_highlighter_highlight_arithmetic $i; then
            (( i = REPLY ))
            reply=($saved_reply $reply)
            continue
          fi

          (( i += 2 ))
          _zsh_highlight_main_highlighter_highlight_list $(( start_pos + i - 1 )) S $has_end $arg[i,end_pos]
          ret=$?
          (( i += REPLY ))
          reply=(
            $saved_reply
            $j $(( start_pos + i )) command-substitution-quoted
            $j $(( j + 2 )) command-substitution-delimiter-quoted
            $reply
          )
          if (( ret == 0 )); then
            reply+=($(( start_pos + i - 1 )) $(( start_pos + i )) command-substitution-delimiter)
          fi
          continue
        else
          continue
        fi
        ;;
      ($histchars[1])
        if [[ $arg[i+1] != ('='|$'\x28'|$'\x7b'|[[:blank:]]) ]]; then
          style=history-expansion
        else
          continue
        fi
        ;;
      *)
        continue
        ;;
    esac
    reply+=($j $k $style)
  done

  if [[ $arg[i] != ')' ]]; then
    (( i-- ))
  fi
    style=arithmetic-expansion
  reply=($(( start_pos + $1 - 1)) $(( start_pos + i )) arithmetic-expansion $reply)
  REPLY=$i
}

_zsh_highlight_main_highlighter_expand_path()
{
  (( $# == 1 )) || print -r -- >&2 "zsh-syntax-highlighting: BUG: _zsh_highlight_main_highlighter_expand_path: called without argument"

  setopt localoptions nonomatch
  unset REPLY
  : ${REPLY:=${(Q)${~1}}}
}

_zsh_highlight_main__precmd_hook() {
  setopt localoptions
  if eval '[[ -o warnnestedvar ]]' 2>/dev/null; then
    unsetopt warnnestedvar
  fi

  _zsh_highlight_main__command_type_cache=()
}

autoload -Uz add-zsh-hook
if add-zsh-hook precmd _zsh_highlight_main__precmd_hook 2>/dev/null; then
  typeset -gA _zsh_highlight_main__command_type_cache
else
  print -r -- >&2 'zsh-syntax-highlighting: Failed to load add-zsh-hook. Some speed optimizations will not be used.'
  unset _zsh_highlight_main__command_type_cache
fi
typeset -ga ZSH_HIGHLIGHT_DIRS_BLACKLIST

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/pattern/pattern-highlighter.zsh
typeset -gA ZSH_HIGHLIGHT_PATTERNS

_zsh_highlight_highlighter_pattern_predicate()
{
  _zsh_highlight_buffer_modified
}

_zsh_highlight_highlighter_pattern_paint()
{
  setopt localoptions extendedglob
  local pattern
  for pattern in ${(k)ZSH_HIGHLIGHT_PATTERNS}; do
    _zsh_highlight_pattern_highlighter_loop "$BUFFER" "$pattern"
  done
}

_zsh_highlight_pattern_highlighter_loop()
{
  local buf="$1" pat="$2"
  local -a match mbegin mend
  local MATCH; integer MBEGIN MEND
  if [[ "$buf" == (#b)(*)(${~pat})* ]]; then
    region_highlight+=("$((mbegin[2] - 1)) $mend[2] $ZSH_HIGHLIGHT_PATTERNS[$pat], memo=zsh-syntax-highlighting")
    "$0" "$match[1]" "$pat"; return $?
  fi
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/regexp/regexp-highlighter.zsh
typeset -gA ZSH_HIGHLIGHT_REGEXP

_zsh_highlight_highlighter_regexp_predicate()
{
  _zsh_highlight_buffer_modified
}

_zsh_highlight_highlighter_regexp_paint()
{
  setopt localoptions extendedglob
  local pattern
  for pattern in ${(k)ZSH_HIGHLIGHT_REGEXP}; do
    _zsh_highlight_regexp_highlighter_loop "$BUFFER" "$pattern"
  done
}

_zsh_highlight_regexp_highlighter_loop()
{
  local buf="$1" pat="$2"
  integer OFFSET=0
  local MATCH; integer MBEGIN MEND
  local -a match mbegin mend
  while true; do
    [[ "$buf" =~ "$pat" ]] || return;
    region_highlight+=("$((MBEGIN - 1 + OFFSET)) $((MEND + OFFSET)) $ZSH_HIGHLIGHT_REGEXP[$pat], memo=zsh-syntax-highlighting")
    buf="$buf[$(($MEND+1)),-1]"
    OFFSET=$((MEND+OFFSET));
  done
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/highlighters/root/root-highlighter.zsh
: ${ZSH_HIGHLIGHT_STYLES[root]:=standout}

_zsh_highlight_highlighter_root_predicate()
{
  _zsh_highlight_buffer_modified
}

_zsh_highlight_highlighter_root_paint()
{
  if (( EUID == 0 )) { _zsh_highlight_add_highlight 0 $#BUFFER root }
}

# Source: https://github.com/zsh-users/zsh-syntax-highlighting/blob/0.8.0/zsh-syntax-highlighting.zsh
_zsh_highlight_preexec_hook()
{
  typeset -g _ZSH_HIGHLIGHT_PRIOR_BUFFER=
  typeset -gi _ZSH_HIGHLIGHT_PRIOR_CURSOR=
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec _zsh_highlight_preexec_hook 2>/dev/null || {
    print -r -- >&2 'zsh-syntax-highlighting: failed loading add-zsh-hook.'
  }

zmodload zsh/parameter 2>/dev/null || true

[[ $#ZSH_HIGHLIGHT_HIGHLIGHTERS -eq 0 ]] && ZSH_HIGHLIGHT_HIGHLIGHTERS=(main)

if (( $+X_ZSH_HIGHLIGHT_DIRS_BLACKLIST )); then
  print >&2 'zsh-syntax-highlighting: X_ZSH_HIGHLIGHT_DIRS_BLACKLIST is deprecated. Please use ZSH_HIGHLIGHT_DIRS_BLACKLIST.'
  ZSH_HIGHLIGHT_DIRS_BLACKLIST=($X_ZSH_HIGHLIGHT_DIRS_BLACKLIST)
  unset X_ZSH_HIGHLIGHT_DIRS_BLACKLIST
fi

eval "$zsh_highlight__aliases"
builtin unset zsh_highlight__aliases

true
