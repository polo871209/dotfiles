# Source: https://github.com/zsh-users/zsh-autosuggestions/blob/v0.7.1/zsh-autosuggestions.zsh
#
# Copyright (c) 2013 Thiago de Arruda
# Copyright (c) 2016-2021 Eric Freese
#
# Permission is hereby granted, free of charge, to any person
# obtaining a copy of this software and associated documentation
# files (the "Software"), to deal in the Software without
# restriction, including without limitation the rights to use,
# copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the
# Software is furnished to do so, subject to the following
# conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
# OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
# WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
# OTHER DEALINGS IN THE SOFTWARE.

(( ! ${+ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE} )) &&
typeset -g ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE='fg=8'

(( ! ${+ZSH_AUTOSUGGEST_ORIGINAL_WIDGET_PREFIX} )) &&
typeset -g ZSH_AUTOSUGGEST_ORIGINAL_WIDGET_PREFIX=autosuggest-orig-

(( ! ${+ZSH_AUTOSUGGEST_STRATEGY} )) && {
	typeset -ga ZSH_AUTOSUGGEST_STRATEGY
	ZSH_AUTOSUGGEST_STRATEGY=(history)
}

(( ! ${+ZSH_AUTOSUGGEST_CLEAR_WIDGETS} )) && {
	typeset -ga ZSH_AUTOSUGGEST_CLEAR_WIDGETS
	ZSH_AUTOSUGGEST_CLEAR_WIDGETS=(
		history-search-forward
		history-search-backward
		history-beginning-search-forward
		history-beginning-search-backward
		history-beginning-search-forward-end
		history-beginning-search-backward-end
		history-substring-search-up
		history-substring-search-down
		up-line-or-beginning-search
		down-line-or-beginning-search
		up-line-or-history
		down-line-or-history
		accept-line
		copy-earlier-word
	)
}

(( ! ${+ZSH_AUTOSUGGEST_ACCEPT_WIDGETS} )) && {
	typeset -ga ZSH_AUTOSUGGEST_ACCEPT_WIDGETS
	ZSH_AUTOSUGGEST_ACCEPT_WIDGETS=(
		forward-char
		end-of-line
		vi-forward-char
		vi-end-of-line
		vi-add-eol
	)
}

(( ! ${+ZSH_AUTOSUGGEST_EXECUTE_WIDGETS} )) && {
	typeset -ga ZSH_AUTOSUGGEST_EXECUTE_WIDGETS
	ZSH_AUTOSUGGEST_EXECUTE_WIDGETS=(
	)
}

(( ! ${+ZSH_AUTOSUGGEST_PARTIAL_ACCEPT_WIDGETS} )) && {
	typeset -ga ZSH_AUTOSUGGEST_PARTIAL_ACCEPT_WIDGETS
	ZSH_AUTOSUGGEST_PARTIAL_ACCEPT_WIDGETS=(
		forward-word
		emacs-forward-word
		vi-forward-word
		vi-forward-word-end
		vi-forward-blank-word
		vi-forward-blank-word-end
		vi-find-next-char
		vi-find-next-char-skip
	)
}

(( ! ${+ZSH_AUTOSUGGEST_IGNORE_WIDGETS} )) && {
	typeset -ga ZSH_AUTOSUGGEST_IGNORE_WIDGETS
	ZSH_AUTOSUGGEST_IGNORE_WIDGETS=(
		orig-\*
		beep
		run-help
		set-local-history
		which-command
		yank
		yank-pop
		zle-\*
	)
}

(( ! ${+ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME} )) &&
typeset -g ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME=zsh_autosuggest_completion_pty

_zsh_autosuggest_escape_command() {
	setopt localoptions EXTENDED_GLOB

	echo -E "${1//(#m)[\"\'\\()\[\]|*?~]/\\$MATCH}"
}

_zsh_autosuggest_incr_bind_count() {
	typeset -gi bind_count=$((_ZSH_AUTOSUGGEST_BIND_COUNTS[$1]+1))
	_ZSH_AUTOSUGGEST_BIND_COUNTS[$1]=$bind_count
}

_zsh_autosuggest_bind_widget() {
	typeset -gA _ZSH_AUTOSUGGEST_BIND_COUNTS

	local widget=$1
	local autosuggest_action=$2
	local prefix=$ZSH_AUTOSUGGEST_ORIGINAL_WIDGET_PREFIX

	local -i bind_count

	case $widgets[$widget] in
		user:_zsh_autosuggest_(bound|orig)_*)
			bind_count=$((_ZSH_AUTOSUGGEST_BIND_COUNTS[$widget]))
			;;

		user:*)
			_zsh_autosuggest_incr_bind_count $widget
			zle -N $prefix$bind_count-$widget ${widgets[$widget]#*:}
			;;

		builtin)
			_zsh_autosuggest_incr_bind_count $widget
			eval "_zsh_autosuggest_orig_${(q)widget}() { zle .${(q)widget} }"
			zle -N $prefix$bind_count-$widget _zsh_autosuggest_orig_$widget
			;;

		completion:*)
			_zsh_autosuggest_incr_bind_count $widget
			eval "zle -C $prefix$bind_count-${(q)widget} ${${(s.:.)widgets[$widget]}[2,3]}"
			;;
	esac

	eval "_zsh_autosuggest_bound_${bind_count}_${(q)widget}() {
		_zsh_autosuggest_widget_$autosuggest_action $prefix$bind_count-${(q)widget} \$@
	}"

	zle -N -- $widget _zsh_autosuggest_bound_${bind_count}_$widget
}

_zsh_autosuggest_bind_widgets() {
	emulate -L zsh

	local widget
	local ignore_widgets

	ignore_widgets=(
		.\*
		_\*
		${_ZSH_AUTOSUGGEST_BUILTIN_ACTIONS/#/autosuggest-}
		$ZSH_AUTOSUGGEST_ORIGINAL_WIDGET_PREFIX\*
		$ZSH_AUTOSUGGEST_IGNORE_WIDGETS
	)

	for widget in ${${(f)"$(builtin zle -la)"}:#${(j:|:)~ignore_widgets}}; do
		if [[ -n ${ZSH_AUTOSUGGEST_CLEAR_WIDGETS[(r)$widget]} ]]; then
			_zsh_autosuggest_bind_widget $widget clear
		elif [[ -n ${ZSH_AUTOSUGGEST_ACCEPT_WIDGETS[(r)$widget]} ]]; then
			_zsh_autosuggest_bind_widget $widget accept
		elif [[ -n ${ZSH_AUTOSUGGEST_EXECUTE_WIDGETS[(r)$widget]} ]]; then
			_zsh_autosuggest_bind_widget $widget execute
		elif [[ -n ${ZSH_AUTOSUGGEST_PARTIAL_ACCEPT_WIDGETS[(r)$widget]} ]]; then
			_zsh_autosuggest_bind_widget $widget partial_accept
		else
			_zsh_autosuggest_bind_widget $widget modify
		fi
	done
}

_zsh_autosuggest_invoke_original_widget() {
	(( $# )) || return 0

	local original_widget_name="$1"

	shift

	if (( ${+widgets[$original_widget_name]} )); then
		zle $original_widget_name -- $@
	fi
}

_zsh_autosuggest_highlight_reset() {
	typeset -g _ZSH_AUTOSUGGEST_LAST_HIGHLIGHT

	if [[ -n "$_ZSH_AUTOSUGGEST_LAST_HIGHLIGHT" ]]; then
		region_highlight=("${(@)region_highlight:#$_ZSH_AUTOSUGGEST_LAST_HIGHLIGHT}")
		unset _ZSH_AUTOSUGGEST_LAST_HIGHLIGHT
	fi
}

_zsh_autosuggest_highlight_apply() {
	typeset -g _ZSH_AUTOSUGGEST_LAST_HIGHLIGHT

	if (( $#POSTDISPLAY )); then
		typeset -g _ZSH_AUTOSUGGEST_LAST_HIGHLIGHT="$#BUFFER $(($#BUFFER + $#POSTDISPLAY)) $ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE"
		region_highlight+=("$_ZSH_AUTOSUGGEST_LAST_HIGHLIGHT")
	else
		unset _ZSH_AUTOSUGGEST_LAST_HIGHLIGHT
	fi
}

_zsh_autosuggest_disable() {
	typeset -g _ZSH_AUTOSUGGEST_DISABLED
	_zsh_autosuggest_clear
}

_zsh_autosuggest_enable() {
	unset _ZSH_AUTOSUGGEST_DISABLED

	if (( $#BUFFER )); then
		_zsh_autosuggest_fetch
	fi
}

_zsh_autosuggest_toggle() {
	if (( ${+_ZSH_AUTOSUGGEST_DISABLED} )); then
		_zsh_autosuggest_enable
	else
		_zsh_autosuggest_disable
	fi
}

_zsh_autosuggest_clear() {
	POSTDISPLAY=

	_zsh_autosuggest_invoke_original_widget $@
}

_zsh_autosuggest_modify() {
	local -i retval

	local -i KEYS_QUEUED_COUNT

	local orig_buffer="$BUFFER"
	local orig_postdisplay="$POSTDISPLAY"

	POSTDISPLAY=

	_zsh_autosuggest_invoke_original_widget $@
	retval=$?

	emulate -L zsh

	if (( $PENDING > 0 || $KEYS_QUEUED_COUNT > 0 )); then
		POSTDISPLAY="$orig_postdisplay"
		return $retval
	fi

	if [[ "$BUFFER" = "$orig_buffer"* && "$orig_postdisplay" = "${BUFFER:$#orig_buffer}"* ]]; then
		POSTDISPLAY="${orig_postdisplay:$(($#BUFFER - $#orig_buffer))}"
		return $retval
	fi

	if (( ${+_ZSH_AUTOSUGGEST_DISABLED} )); then
		return $?
	fi

	if (( $#BUFFER > 0 )); then
		if [[ -z "$ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE" ]] || (( $#BUFFER <= $ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE )); then
			_zsh_autosuggest_fetch
		fi
	fi

	return $retval
}

_zsh_autosuggest_fetch() {
	if (( ${+ZSH_AUTOSUGGEST_USE_ASYNC} )); then
		_zsh_autosuggest_async_request "$BUFFER"
	else
		local suggestion
		_zsh_autosuggest_fetch_suggestion "$BUFFER"
		_zsh_autosuggest_suggest "$suggestion"
	fi
}

_zsh_autosuggest_suggest() {
	emulate -L zsh

	local suggestion="$1"

	if [[ -n "$suggestion" ]] && (( $#BUFFER )); then
		POSTDISPLAY="${suggestion#$BUFFER}"
	else
		POSTDISPLAY=
	fi
}

_zsh_autosuggest_accept() {
	local -i retval max_cursor_pos=$#BUFFER

	if [[ "$KEYMAP" = "vicmd" ]]; then
		max_cursor_pos=$((max_cursor_pos - 1))
	fi

	if (( $CURSOR != $max_cursor_pos || !$#POSTDISPLAY )); then
		_zsh_autosuggest_invoke_original_widget $@
		return
	fi

	BUFFER="$BUFFER$POSTDISPLAY"

	POSTDISPLAY=

	_zsh_autosuggest_invoke_original_widget $@
	retval=$?

	if [[ "$KEYMAP" = "vicmd" ]]; then
		CURSOR=$(($#BUFFER - 1))
	else
		CURSOR=$#BUFFER
	fi

	return $retval
}

_zsh_autosuggest_execute() {
	BUFFER="$BUFFER$POSTDISPLAY"

	POSTDISPLAY=

	_zsh_autosuggest_invoke_original_widget "accept-line"
}

_zsh_autosuggest_partial_accept() {
	local -i retval cursor_loc

	local original_buffer="$BUFFER"

	BUFFER="$BUFFER$POSTDISPLAY"

	_zsh_autosuggest_invoke_original_widget $@
	retval=$?

	cursor_loc=$CURSOR
	if [[ "$KEYMAP" = "vicmd" ]]; then
		cursor_loc=$((cursor_loc + 1))
	fi

	if (( $cursor_loc > $#original_buffer )); then
		POSTDISPLAY="${BUFFER[$(($cursor_loc + 1)),$#BUFFER]}"

		BUFFER="${BUFFER[1,$cursor_loc]}"
	else
		BUFFER="$original_buffer"
	fi

	return $retval
}

() {
	typeset -ga _ZSH_AUTOSUGGEST_BUILTIN_ACTIONS

	_ZSH_AUTOSUGGEST_BUILTIN_ACTIONS=(
		clear
		fetch
		suggest
		accept
		execute
		enable
		disable
		toggle
	)

	local action
	for action in $_ZSH_AUTOSUGGEST_BUILTIN_ACTIONS modify partial_accept; do
		eval "_zsh_autosuggest_widget_$action() {
			local -i retval

			_zsh_autosuggest_highlight_reset

			_zsh_autosuggest_$action \$@
			retval=\$?

			_zsh_autosuggest_highlight_apply

			zle -R

			return \$retval
		}"
	done

	for action in $_ZSH_AUTOSUGGEST_BUILTIN_ACTIONS; do
		zle -N autosuggest-$action _zsh_autosuggest_widget_$action
	done
}

_zsh_autosuggest_capture_postcompletion() {
	compstate[insert]=1

	unset 'compstate[list]'
}

_zsh_autosuggest_capture_completion_widget() {
	local -a +h comppostfuncs
	comppostfuncs=(_zsh_autosuggest_capture_postcompletion)

	CURSOR=$#BUFFER

	zle -- ${(k)widgets[(r)completion:.complete-word:_main_complete]}

	if is-at-least 5.0.3; then
		stty -onlcr -ocrnl -F /dev/tty
	fi

	echo -nE - $'\0'$BUFFER$'\0'
}

zle -N autosuggest-capture-completion _zsh_autosuggest_capture_completion_widget

_zsh_autosuggest_capture_setup() {
	if ! is-at-least 5.4; then
		zshexit() {
			kill -KILL $$ 2>&- || command kill -KILL $$

			sleep 1
		}
	fi

	zstyle ':completion:*' matcher-list ''
	zstyle ':completion:*' path-completion false
	zstyle ':completion:*' max-errors 0 not-numeric

	bindkey '^I' autosuggest-capture-completion
}

_zsh_autosuggest_capture_completion_sync() {
	_zsh_autosuggest_capture_setup

	zle autosuggest-capture-completion
}

_zsh_autosuggest_capture_completion_async() {
	_zsh_autosuggest_capture_setup

	zmodload zsh/parameter 2>/dev/null || return

	autoload +X _complete
	functions[_original_complete]=$functions[_complete]
	function _complete() {
		unset 'compstate[vared]'
		_original_complete "$@"
	}

	vared 1
}

_zsh_autosuggest_strategy_completion() {
	emulate -L zsh

	setopt EXTENDED_GLOB

	typeset -g suggestion
	local line REPLY

	whence compdef >/dev/null || return

	zmodload zsh/zpty 2>/dev/null || return

	[[ -n "$ZSH_AUTOSUGGEST_COMPLETION_IGNORE" ]] && [[ "$1" == $~ZSH_AUTOSUGGEST_COMPLETION_IGNORE ]] && return

	if zle; then
		zpty $ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME _zsh_autosuggest_capture_completion_sync
	else
		zpty $ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME _zsh_autosuggest_capture_completion_async "\$1"
		zpty -w $ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME $'\t'
	fi

	{
		zpty -r $ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME line '*'$'\0''*'$'\0'

		suggestion="${${(@0)line}[2]}"
	} always {
		zpty -d $ZSH_AUTOSUGGEST_COMPLETIONS_PTY_NAME
	}
}

_zsh_autosuggest_strategy_history() {
	emulate -L zsh

	setopt EXTENDED_GLOB

	local prefix="${1//(#m)[\\*?[\]<>()|^~#]/\\$MATCH}"

	local pattern="$prefix*"
	if [[ -n $ZSH_AUTOSUGGEST_HISTORY_IGNORE ]]; then
		pattern="($pattern)~($ZSH_AUTOSUGGEST_HISTORY_IGNORE)"
	fi

	typeset -g suggestion="${history[(r)$pattern]}"
}

_zsh_autosuggest_strategy_match_prev_cmd() {
	emulate -L zsh

	setopt EXTENDED_GLOB

	local prefix="${1//(#m)[\\*?[\]<>()|^~#]/\\$MATCH}"

	local pattern="$prefix*"
	if [[ -n $ZSH_AUTOSUGGEST_HISTORY_IGNORE ]]; then
		pattern="($pattern)~($ZSH_AUTOSUGGEST_HISTORY_IGNORE)"
	fi

	local history_match_keys
	history_match_keys=(${(k)history[(R)$~pattern]})

	local histkey="${history_match_keys[1]}"

	local prev_cmd="$(_zsh_autosuggest_escape_command "${history[$((HISTCMD-1))]}")"

	for key in "${(@)history_match_keys[1,200]}"; do
		[[ $key -gt 1 ]] || break

		if [[ "${history[$((key - 1))]}" == "$prev_cmd" ]]; then
			histkey="$key"
			break
		fi
	done

	typeset -g suggestion="$history[$histkey]"
}

_zsh_autosuggest_fetch_suggestion() {
	typeset -g suggestion
	local -a strategies
	local strategy

	strategies=(${=ZSH_AUTOSUGGEST_STRATEGY})

	for strategy in $strategies; do
		_zsh_autosuggest_strategy_$strategy "$1"

		[[ "$suggestion" != "$1"* ]] && unset suggestion

		[[ -n "$suggestion" ]] && break
	done
}

_zsh_autosuggest_async_request() {
	zmodload zsh/system 2>/dev/null

	typeset -g _ZSH_AUTOSUGGEST_ASYNC_FD _ZSH_AUTOSUGGEST_CHILD_PID

	if [[ -n "$_ZSH_AUTOSUGGEST_ASYNC_FD" ]] && { true <&$_ZSH_AUTOSUGGEST_ASYNC_FD } 2>/dev/null; then
		builtin exec {_ZSH_AUTOSUGGEST_ASYNC_FD}<&-
		zle -F $_ZSH_AUTOSUGGEST_ASYNC_FD

		if [[ -n "$_ZSH_AUTOSUGGEST_CHILD_PID" ]]; then
			if [[ -o MONITOR ]]; then
				kill -TERM -$_ZSH_AUTOSUGGEST_CHILD_PID 2>/dev/null
			else
				kill -TERM $_ZSH_AUTOSUGGEST_CHILD_PID 2>/dev/null
			fi
		fi
	fi

	builtin exec {_ZSH_AUTOSUGGEST_ASYNC_FD}< <(
		echo $sysparams[pid]

		local suggestion
		_zsh_autosuggest_fetch_suggestion "$1"
		echo -nE "$suggestion"
	)

	autoload -Uz is-at-least
	is-at-least 5.8 || command true

	read _ZSH_AUTOSUGGEST_CHILD_PID <&$_ZSH_AUTOSUGGEST_ASYNC_FD

	zle -F "$_ZSH_AUTOSUGGEST_ASYNC_FD" _zsh_autosuggest_async_response
}

_zsh_autosuggest_async_response() {
	emulate -L zsh

	local suggestion

	if [[ -z "$2" || "$2" == "hup" ]]; then
		IFS='' read -rd '' -u $1 suggestion
		zle autosuggest-suggest -- "$suggestion"

		builtin exec {1}<&-
	fi

	zle -F "$1"
	_ZSH_AUTOSUGGEST_ASYNC_FD=
}

_zsh_autosuggest_start() {
	if (( ${+ZSH_AUTOSUGGEST_MANUAL_REBIND} )); then
		add-zsh-hook -d precmd _zsh_autosuggest_start
	fi

	_zsh_autosuggest_bind_widgets
}

autoload -Uz add-zsh-hook is-at-least

if is-at-least 5.0.8; then
	typeset -g ZSH_AUTOSUGGEST_USE_ASYNC=
fi

add-zsh-hook precmd _zsh_autosuggest_start
