## Quick Setup

```bash
git clone https://github.com/polo871209/dotfiles.git && cd dotfiles

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew bundle install

# Create symbolic links for all configuration files
stow .

# Configure shell environment variables
cat ~/dotfiles/dot_zshenv >| ~/.zshenv
touch ~/.hushlogin
```

```bash
# Generate SSH key and configure Git for authenticated access
ssh-keygen -t ed25519
git remote set-url origin git@github.com:polo871209/dotfiles.git
```


```nu
nu
echo "source ~/.config/nushell/config.nu" | save $nu.config-path
echo "source ~/.config/nushell/env.nu" | save $nu.env-path
sudo echo "$(which nu)" >> /etc/shells
chsh -s /opt/homebrew/bin/nu
```

## Notes

```bash
# Setup note-taking vault (requires Google Drive to be logged in first)
mkdir ~/vaults && cd ~/Google\ Drive/My\ Drive/vaults && stow .
```

```bash
# Using python standard venv with direnv
cat >> .envrc << 'EOF'
export VIRTUAL_ENV=.venv
layout python3
EOF
direnv allow
```
