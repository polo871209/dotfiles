dotfiles := justfile_directory()

default:
    @just --list

# Stow, link global skills, and link Hex settings.json
link:
    #!/usr/bin/env bash
    set -euo pipefail
    stow .
    rm -rf ~/.pi
    ln -sfn {{dotfiles}}/.pi ~/.pi
    # atuin reads ~/.atuin/config.toml first, and writes its example config there whenever no config exists.
    mkdir -p ~/.atuin
    ln -sfn {{dotfiles}}/atuin/config.toml ~/.atuin/config.toml
    hex_settings="$HOME/Library/Application Support/hex/settings.json"
    hex_source="{{dotfiles}}/hex/settings.json"
    # Hex skips onboarding (permissions, model download) when settings.json already exists.
    if [[ ! -f "$HOME/Library/Application Support/hex/onboarding-complete" ]]; then
        echo "Skipped Hex: open Hex, finish onboarding, then run just link again"
    elif [[ "$(readlink "$hex_settings")" != "$hex_source" ]]; then
        ln -sfn "$hex_source" "$hex_settings"
        /Applications/Hex.app/Contents/MacOS/hex restart
    fi

# Update third-party skills in .agents/skills from skills-lock.json
update-skill:
    DISABLE_TELEMETRY=1 GITHUB_TOKEN="$(gh auth token)" npx -y skills@latest update -p -y

# Native markdown viewer that nvim opens with <leader>tm: `just mdview`, `just mdview test`
mod mdview "nvim/mdview"

# Rex app extensions, such as the ⌘K session picker: `just rex` patches Rex, `just rex unpatch`
mod rex "rex/extensions"

# Build the zsh prompt and install it to ~/.local/bin, where zsh finds it
[working-directory: "zprompt"]
zprompt:
    cargo build --release --locked
    install -m 755 target/release/zprompt ~/.local/bin/zprompt

[working-directory: "zprompt"]
zprompt-test:
    cargo clippy --all-targets -- -D warnings
    cargo test
