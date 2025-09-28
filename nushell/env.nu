# Init nushell completions
# mkdir $"($nu.cache-dir)"
# atuin init nu | save --force $"($nu.cache-dir)/atuin.nu" 
# carapace _carapace nushell | save --force $"($nu.cache-dir)/carapace.nu"
# zoxide init nushell | save --force $"($nu.cache-dir)/zoxide.nu"

$env.PATH ++= [
    ($env.HOME | path join "go" "bin")
    "/opt/homebrew/bin"
    "~/dotfiles/scripts"
    "~/.local/bin"
    "~/.cargo/bin"
]

$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense'

# Shell Configuration
$env.CLOUDSDK_CONFIG = ($env.HOME | path join ".gcloud")
$env.GOOGLE_APPLICATION_CREDENTIALS = ($env.CLOUDSDK_CONFIG | path join "application_default_credentials.json")

$env.BAT_THEME = "OneHalfDark"
$env.EDITOR = "nvim"
$env.HWATCH = "--color"
$env.PAGER = "bat --paging=always"
$env.MANPAGER = "sh -c 'col -bx | bat -l man -p'"
$env.KUBE_EDITOR = "vim"

$env.DOCKER_DEFAULT_PLATFORM = "linux/amd64"
$env.DOCKER_HOST = (docker context inspect | from json | get 0.Endpoints.docker.Host)

$env.POETRY_VIRTUALENVS_IN_PROJECT = "true"

$env.TERM = "xterm-256color"

$env.HOMEBREW_NO_ENV_HINTS = "1"
