# Auto-activate Python virtual environments when entering directories
# This plugin automatically activates .venv when entering a directory with one
function auto_venv() {
    if [[ -f .venv/bin/activate ]]; then
        if [[ -z "$VIRTUAL_ENV" || "$VIRTUAL_ENV" != "$(pwd)/.venv" ]]; then
            source .venv/bin/activate
            echo "Activated virtual environment: $(pwd)/.venv"
        fi
    elif [[ -n "$VIRTUAL_ENV" ]]; then
        deactivate
        echo "Deactivated virtual environment."
    fi
}

autoload -U add-zsh-hook
add-zsh-hook chpwd auto_venv
auto_venv
