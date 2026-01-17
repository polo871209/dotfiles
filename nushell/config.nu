$env.config.buffer_editor = ["nvim" "-c" "set filetype=nu"]
$env.config.show_banner = false

alias bat = bat --color=always
alias c = pbcopy
alias cafe = caffeinate -id asciiquarium
alias cls = clear
alias io = istioctl
alias j = just
alias k = kubectl
alias ka = kubectl-argo-rollouts
alias kctx = kubectx
alias kns = kubens
alias lg = lazygit
alias n = nvim
alias o = open .
alias oc = opencode --port
alias tf = terraform

def sz [] {
    source ($nu.env-path)
}

def h [command: string, ...args] {
    run-external $command ...$args "--help" | bat --plain --language=help
}

def nf [] {
    let file = (fzf --preview "bat --color=always --style=numbers --line-range=:500 {}")
    if ($file | is-not-empty) {
        if ($file | path type) == "dir" {
            cd $file
            nvim
        } else {
            nvim $file
        }
    }
}

def divelocal [image: string, ...args] {
    dive (docker save $image) --source=docker-archive ...$args
}

def s [] {
    let session = (sesh list -t -c | fzf --height 40% --reverse --border-label ' sesh ' --border --prompt '⚡  ')
    if ($session | is-not-empty) {
        sesh connect $session
    }
}

if ('~/.config/nushell/.secret.nu' | path expand | path exists) {
    source ~/.config/nushell/.secret.nu
}

oh-my-posh init nu --config $"($env.XDG_CONFIG_HOME)/ohmyposh/config.yaml"
source $"($nu.cache-dir)/atuin.nu" 
source $"($nu.cache-dir)/carapace.nu"
source $"($nu.cache-dir)/zoxide.nu"

use std/config *

# Initialize the PWD hook as an empty list if it doesn't exist
$env.config.hooks.env_change.PWD = $env.config.hooks.env_change.PWD? | default []

$env.config.hooks.env_change.PWD ++= [{||
  if (which direnv | is-empty) {
    # If direnv isn't installed, do nothing
    return
  }

  direnv export json | from json | default {} | load-env
  # If direnv changes the PATH, it will become a string and we need to re-convert it to a list
  $env.PATH = do (env-conversions).path.from_string $env.PATH
}]
