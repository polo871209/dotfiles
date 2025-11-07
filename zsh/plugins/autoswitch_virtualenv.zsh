function auto_venv() {
    local venv_path="${PWD}/.venv"

    [[ "$VIRTUAL_ENV" == "$venv_path" ]] && return

    if [[ -f "${venv_path}/bin/activate" ]]; then
        source "${venv_path}/bin/activate"
    elif [[ -n "$VIRTUAL_ENV" ]]; then
        deactivate
    fi
}

autoload -U add-zsh-hook
add-zsh-hook chpwd auto_venv
auto_venv
