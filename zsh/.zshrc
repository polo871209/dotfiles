setopt prompt_subst

# Auto Complete
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
zstyle ':completion:*:git:*' group-order 'main commands' 'alias commands' 'external commands'
autoload -Uz compinit; compinit
source <(uv generate-shell-completion zsh)
source <(carapace _carapace)

export PATH="/opt/homebrew/bin:$PATH"
source /opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh
source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Aliases
alias c="code ."
alias cafe="fastfetch && caffeinate -d"
alias cls="clear"
alias lg="lazygit"
alias ls="eza --group-directories-first -a --icons"
alias k="kubectl"
alias kctx="kubectx"
alias kns="kubens"
alias n="nvim"
alias o="open ."
alias tf="terraform"

# Configuration Reloads & Updates
alias nixup="nix flake update --flake $HOME/dotfiles/nix && darwin-rebuild switch --flake $HOME/dotfiles/nix"
alias nixclean="nix-store --gc"
alias st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"

# Editor & Formatter
alias pretty="npx prettier-init"
alias setenv='echo '\''{ "venvPath": ".", "venv": ".venv" }'\'' > pyrightconfig.json'

# Bat
export BAT_THEME="OneHalfDark"
alias cat="bat --color=always"
alias -g -- -h='-h 2>&1 | bat --language=help --style=plain'
alias -g -- --help='--help 2>&1 | bat --language=help --style=plain'
h() {
    "$@" --help 2>&1 | bat --plain --language=help
}

# FZF
source <(fzf --zsh)
export FZF_DEFAULT_COMMAND="fd --hidden --strip-cwd-prefix --exclude .git --exclude .venv"
nf() {
    file=$(fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    [ -d $file ] && cd $file && nvim || nvim $file
}
alias url="tmux capture-pane -J -p | grep -oE '(https?):\/\/.*[^>]' | fzf-tmux -d20 --multi --bind alt-a:select-all,alt-d:deselect-all | xargs open"

# Functions
cs() {
    touch "$1.sh" && chmod +x "$1.sh"
    bat --plain  <<EOF >> "$1.sh"
#!/usr/bin/env bash

set -euo pipefail
EOF
}

eval "$(oh-my-posh init zsh --config $XDG_CONFIG_HOME/ohmyposh/config.yaml)"
eval "$(atuin init zsh)"
eval "$(direnv hook zsh)"
eval "$(zoxide init zsh)"
