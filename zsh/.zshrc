setopt prompt_subst
bindkey jj vi-cmd-mode

#Autocomplete
zstyle ':completion:*' menu select
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
export CARAPACE_BRIDGES='zsh,fish,bash,inshellisense' # optional
zstyle ':completion:*' format $'\e[2;37mCompleting %d\e[m'
zstyle ':completion:*:git:*' group-order 'main commands' 'alias commands' 'external commands'
autoload -Uz compinit; compinit
source <(uv generate-shell-completion zsh)
source <(carapace _carapace)

export BREW_PREFIX="/opt/homebrew/share"
export PATH="/opt/homebrew/bin:$PATH"
source $BREW_PREFIX/zsh-autosuggestions/zsh-autosuggestions.zsh
source $BREW_PREFIX/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# Aliases
# Tool Replacements
alias pwd="pwdcopy"
pwdcopy() {
    command pwd "$@" | tr -d '\n' | pbcopy
    command pwd "$@"
}
alias ls="eza --group-directories-first -a --icons"
alias vi="nvim"
alias vim="nvim"
alias cat="bat --color=always"

# Shortened Commands
alias c="code ."
alias cafe="fastfetch && caffeinate -d"
alias cls="clear"
alias ff='fzf --preview "bat --color=always --style=numbers --line-range=:500 {}" | pbcopy'
alias k="kubectl"
alias kctx="kubectx"
alias kns="kubens"
alias lg="lazygit"
alias o="open ."
alias p="poetry"
alias pa="poetry add"
alias tf="terraform"

# URL Copying
alias url="tmux capture-pane -J -p | grep -oE '(https?):\/\/.*[^>]' | fzf-tmux -d20 --multi --bind alt-a:select-all,alt-d:deselect-all | xargs open"

# Configuration Reloads & Updates
alias nixup="nix flake update --flake $HOME/dotfiles/nix && darwin-rebuild switch --flake $HOME/dotfiles/nix"
alias nixclean=" sudo nix-env --delete-generations old"
alias st="tmux source-file ${XDG_CONFIG_HOME:-$HOME}/tmux/tmux.conf"
alias sz="source ${ZDOTDIR:-$HOME}/.zshrc"

# Editor & Formatter
alias pretty="npx prettier-init"
alias setenv='echo '\''{ "venvPath": ".", "venv": ".venv" }'\'' > pyrightconfig.json'

# Help
alias bathelp='bat --plain --language=help'
alias -g -- -h='-h 2>&1 | bat --language=help --style=plain'
alias -g -- --help='--help 2>&1 | bat --language=help --style=plain'
h() {
    "$@" --help 2>&1 | bathelp
}

# Interactive sessions
source <(fzf --zsh)
eval "$(oh-my-posh init zsh --config $XDG_CONFIG_HOME/ohmyposh/config.yaml)"
eval "$(atuin init zsh)"
eval "$(direnv hook zsh)"
eval "$(zoxide init zsh)"

