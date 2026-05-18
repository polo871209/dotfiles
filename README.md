## Tools

- Terminal: [Ghostty](https://ghostty.org/)
- Shell: [ZSH](https://www.zsh.org/)
- Editor: [Nvim](https://neovim.io/)
- Multiplexer: [Tmux](https://github.com/tmux/tmux)
- Prompt: [Oh-my-posh](https://ohmyposh.dev/)
- Completer: [Carapace](https://carapace.sh/)
- History: [Atuin](https://docs.atuin.sh/cli/)
- AI Agent: [pi](https://pi.dev/)
- Browser: [Zen](https://zen-browser.app/)

## Mac Quick Setup

### Init

```bash
git clone https://github.com/polo871209/dotfiles.git && cd dotfiles
cat ~/dotfiles/dot_zshenv >| ~/.zshenv
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew bundle install
npm install -g @earendil-works/pi-coding-agent
just link
touch ~/.hushlogin
./zen-browser/install.sh
```

### Setup Atuin

```bash
atuin setup
```

### Setup SSH and Git Authentication

```bash
ssh-keygen -t ed25519
git remote set-url origin git@github.com:polo871209/dotfiles.git
```

## Additional Configuration

### Note-Taking Vault

Requires Google Drive to be logged in first:

### Python Virtual Environment with direnv

```bash
cat >> .envrc << 'EOF'
export VIRTUAL_ENV=.venv
layout python3
EOF
direnv allow
```
