# Ensure Homebrew bin takes priority over /usr/local/bin (set after path_helper runs)
path=(/opt/homebrew/bin /opt/homebrew/sbin $path)

# Added by OrbStack: command-line tools and integration
# This won't be added again if you remove it.
source ~/.orbstack/shell/init.zsh 2>/dev/null || :
