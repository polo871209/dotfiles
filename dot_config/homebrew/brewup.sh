#/bin/zsh

brew update
brew upgrade
brew cleanup

cd ~/.config/homebrew/
brew bundle dump -f
