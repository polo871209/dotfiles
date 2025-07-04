# Personal Dotfiles

A comprehensive dotfiles configuration for macOS development environment, featuring Neovim, Zsh, Tmux, and various development tools.

## ✨ Features

- **🎯 Neovim**: Modern Lua configuration with LSP, AI assistance, and extensive plugin ecosystem
- **🐚 Zsh**: Optimized shell with autocompletion, syntax highlighting, and custom functions
- **🖥️ Tmux**: Terminal multiplexer with custom configuration
- **🔧 Development Tools**: Git, K9s, Lazygit, and many CLI utilities
- **📦 Package Management**: Homebrew integration with Brewfile
- **🔗 Symlink Management**: GNU Stow for clean configuration organization

## 🛠️ Prerequisites

- macOS (tested on recent versions)
- [Homebrew](https://brew.sh/) package manager
- Git (for cloning the repository)

## 🚀 Quick Setup

```bash
# Clone the repository with submodules
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

## 📁 Configuration Structure

```
dotfiles/
├── nvim/           # Neovim configuration (Lua-based)
├── zsh/            # Zsh shell configuration
├── tmux/           # Tmux terminal multiplexer
├── git/            # Git configuration
├── k9s/            # Kubernetes dashboard
├── lazygit/        # Git TUI configuration
├── ohmyposh/       # Prompt theme configuration
├── scripts/        # Utility scripts
├── Brewfile        # Homebrew package definitions
└── README.md       # This file
```

## 🔧 Key Tools Included

### Development
- **Neovim** - Modern text editor with LSP support
- **Git** - Version control with custom aliases
- **Lazygit** - Terminal UI for Git operations

### Shell & Terminal
- **Zsh** - Advanced shell with autocompletion
- **Tmux** - Terminal multiplexer
- **Oh My Posh** - Cross-platform prompt theme engine

### Kubernetes & DevOps
- **K9s** - Kubernetes cluster management
- **kubectl** - Kubernetes command-line tool
- **Terraform** - Infrastructure as Code

### Utilities
- **fzf** - Fuzzy finder
- **bat** - Enhanced cat with syntax highlighting
- **eza** - Modern ls replacement
- **ripgrep** - Fast text search
- **fd** - Fast find alternative

## 🎨 Customization

### Neovim
The Neovim configuration is located in `nvim/lua/custom/` and includes:
- LSP configurations for multiple languages
- AI-powered coding assistance with CodeCompanion
- Extensive plugin ecosystem
- Custom keymaps and options

### Zsh
Shell configuration includes:
- Custom aliases for common tasks
- Function definitions for enhanced workflow
- Plugin management for autocompletion and syntax highlighting

## 🔍 Troubleshooting

### Common Issues

**Stow conflicts**: If you get conflicts when running `stow .`, remove the conflicting files first:
```bash
rm ~/.zshrc ~/.tmux.conf  # etc.
stow .
```

**Missing Homebrew packages**: Ensure Homebrew is installed and up to date:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew update
```

**Zsh not loading correctly**: Source the configuration manually:
```bash
source ~/.zshrc
```

### Manual Setup Steps

If automatic setup fails, you can manually configure individual components:

1. **Install packages**: `brew bundle install`
2. **Link configs**: `stow nvim zsh tmux git` (or individual directories)
3. **Set shell**: `chsh -s $(which zsh)`

## 📜 License

This is a personal dotfiles repository. Feel free to use any configurations that are helpful for your own setup.

## 🤝 Contributing

While this is a personal configuration, suggestions and improvements are welcome! Please open an issue or pull request.
