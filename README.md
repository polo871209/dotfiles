## Quick Setup

```bash
git clone --recurse-submodules https://github.com/polo871209/dotfiles.git && cd dotfiles

# Install all Homebrew packages and applications
brew bundle install

# Configure shell environment variables
cat ~/dotfiles/dot_zshenv >| ~/.zshenv

# Create symbolic links for all configuration files
stow .

# Generate SSH key and configure Git for authenticated access
ssh-keygen -t ed25519
git remote set-url origin git@github.com:polo871209/dotfiles.git

# Disable login message on terminal startup
touch ~/.hushlogin

# Setup note-taking vault (requires Google Drive to be logged in first)
mkdir ~/vaults && cd ~/Google\ Drive/My\ Drive/vaults && stow .
```

## Notes

```bash
# Using python standard venv with direnv
cat >> .envrc << 'EOF'
export VIRTUAL_ENV=.venv
layout python3
EOF
direnv allow
```
