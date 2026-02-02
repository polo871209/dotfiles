## Tools

- Terminal: [Ghostty](https://ghostty.org/)
- Shell: [Nushell](https://www.nushell.sh/)/[ZSH](https://www.zsh.org/)
- Editor: [Nvim](https://neovim.io/)
- Multiplexer: [Tmux](https://github.com/tmux/tmux)
- Prompt: [Oh-my-posh](https://ohmyposh.dev/)
- Completer: [Carapace](https://carapace.sh/)
- History: [Atuin](https://docs.atuin.sh/cli/)
- AI: [Opencode](https://opencode.ai/)

## Mac Quick Setup

### Init

```bash
git clone https://github.com/polo871209/dotfiles.git && cd dotfiles
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew bundle install
stow .  # Create symbolic links for configuration files
cat ~/dotfiles/dot_zshenv >| ~/.zshenv
touch ~/.hushlogin
```

### Setup SSH and Git Authentication

```bash
ssh-keygen -t ed25519
git remote set-url origin git@github.com:polo871209/dotfiles.git
```

### Configure Nushell(Optional)

```nu
nu
echo "source ~/.config/nushell/config.nu" | save $nu.config-path
echo "source ~/.config/nushell/env.nu" | save $nu.env-path
sudo echo "$(which nu)" >> /etc/shells
chsh -s /opt/homebrew/bin/nu
```

## Additional Configuration

### Note-Taking Vault

Requires Google Drive to be logged in first:

```bash
mkdir ~/vaults && cd ~/Google\ Drive/My\ Drive/vaults && stow .
```

### Python Virtual Environment with direnv

```bash
cat >> .envrc << 'EOF'
export VIRTUAL_ENV=.venv
layout python3
EOF
direnv allow
```
