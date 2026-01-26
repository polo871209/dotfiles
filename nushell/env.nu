$env.XDG_CONFIG_HOME = $"($env.HOME)/.config"
$env.GOPATH = $"($env.HOME)/go"
$env.OBSIDIAN_VAULT = $"($env.HOME)/vaults/obsidian"
$env.CLOUDSDK_CONFIG = $"($env.HOME)/.gcloud"
$env.CLOUDSDK_PYTHON = "/opt/homebrew/bin/python3.14"
$env.GOOGLE_APPLICATION_CREDENTIALS = $"($env.CLOUDSDK_CONFIG)/application_default_credentials.json"

$env.PATH = (
    $env.PATH 
    | split row (char esep) 
    | append [
        $"($env.GOPATH)/bin"
        "/opt/homebrew/bin"
        "~/dotfiles/scripts"
        "~/.local/bin"
        "~/.cargo/bin"
    ]
)

$env.EDITOR = "nvim"
$env.KUBE_EDITOR = "nvim"
$env.TERM = "xterm-256color"
$env.PAGER = "bat --paging=always"
$env.MANPAGER = "sh -c 'col -bx | bat -l man -p'"
$env.LESS = "-iRFX"
$env.BAT_THEME = "OneHalfDark"
$env.BAT_PAGER = "less -iRFK"
$env.HWATCH = "--color"
$env.HOMEBREW_NO_ENV_HINTS = "1"
$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense'
$env.FZF_DEFAULT_COMMAND = "fd --hidden --strip-cwd-prefix --exclude .git --exclude .venv"
$env.FZF_DEFAULT_OPTS = "--select-1"

# Init nushell
# mkdir $"($nu.cache-dir)"
# atuin init nu | save --force $"($nu.cache-dir)/atuin.nu" 
# carapace _carapace nushell | save --force $"($nu.cache-dir)/carapace.nu"
# zoxide init nushell | save --force $"($nu.cache-dir)/zoxide.nu"
