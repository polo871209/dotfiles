$env.config.buffer_editor = "nvim"
$env.config.show_banner = false
$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense' 

# Aliases
alias c = pbcopy
alias cls = clear
alias lg = lazygit
alias ll = ls -a 
alias k = kubectl
alias kctx = kubectx
alias ka = kubectl-argo-rollouts
alias kns = kubens
alias n = nvim
alias o = open .
alias oc = opencode
alias tf = terraform
alias watch = hwatch
alias y = yank

# Configuration Reloads & Updates
alias brewup = brew update; brew upgrade
alias st = tmux source-file ($env.XDG_CONFIG_HOME | default $env.HOME)/tmux/tmux.conf
def sz [] {
    source ($nu.env-path)
}

# Bat
alias bat = bat --color=always

# Sesh
def s [] {
    let session = (sesh list -t -c | fzf --height 40% --reverse --border-label ' sesh ' --border --prompt '⚡  ')
    if ($session | is-not-empty) {
        sesh connect $session
    }
}

oh-my-posh init nu --config $"($env.XDG_CONFIG_HOME)/ohmyposh/config.nu.yaml"
source $"($nu.cache-dir)/atuin.nu" 
source $"($nu.cache-dir)/carapace.nu"
source $"($nu.cache-dir)/zoxide.nu" 
$env.config = {
  hooks: {
    pre_prompt: [{ ||
      if (which direnv | is-empty) {
        return
      }

      direnv export json | from json | default {} | load-env
      if 'ENV_CONVERSIONS' in $env and 'PATH' in $env.ENV_CONVERSIONS {
        $env.PATH = do $env.ENV_CONVERSIONS.PATH.from_string $env.PATH
      }
    }]
  }
}

