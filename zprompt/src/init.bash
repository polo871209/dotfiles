export VIRTUAL_ENV_DISABLE_PROMPT=1
shopt -s checkwinsize
PS1='${_zp_ps1}'
PS2='\[\e[38;2;131;165;152m\]> \[\e[0m\]'

# EPOCHREALTIME needs bash 5. PS0 expands right before each command, and its arithmetic sets the start time in this shell.
# bash skips the arithmetic when _zp_started is unset or empty, so 0 means that no command ran.
if [[ -n $EPOCHREALTIME ]]; then
  _zp_started=0
  PS0='\e]133;C\a${_zp_started:0:$((_zp_started = ${EPOCHREALTIME/[.,]/}, 0))}'
fi

_zp_prompt() {
  local status=$? ran=1 duration=-1
  if [[ -n $EPOCHREALTIME ]]; then
    ran=0
    if (( _zp_started )); then
      ran=1
      duration=$(( (${EPOCHREALTIME/[.,]/} - _zp_started) / 1000 ))
      _zp_started=0
    fi
  fi
  _zp_ps1=$("${_zp_bin:?}" prompt bash fresh "$status" "$ran" "$duration" "${COLUMNS:-0}")
  _zp_report_pwd
  return $status
}

_zp_report_pwd() {
  [[ $PWD == "$_zp_reported_pwd" ]] && return
  _zp_reported_pwd=$PWD
  local LC_ALL=C encoded='' char i
  for ((i = 0; i < ${#PWD}; i++)); do
    char=${PWD:i:1}
    case $char in
      [A-Za-z0-9/._~-]) encoded+=$char ;;
      *) printf -v char '%d' "'$char"; printf -v char '%%%02X' $(( char & 255 )); encoded+=$char ;;
    esac
  done
  printf '\e]7;file://%s%s\e\\' "$HOSTNAME" "$encoded"
}

[[ $PROMPT_COMMAND == _zp_prompt* ]] || PROMPT_COMMAND="_zp_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
