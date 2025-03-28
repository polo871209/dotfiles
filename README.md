# Init New Mac

```bash
git clone https://github.com/polo871209/dotfiles.git

# set XDG_CONFIG_HOME
cat ~/dotfiles/dot_zshenv >| ~/.zshenv

# create config symlinks
stow .

# gen key and add to github
ssh-keygen -t ed25519
git remote set-url origin git@github.com:polo871209/dotfiles.git
./run_once_install_configure_git.sh

# setup notes(login google drive first)
mkdir ~/vaults && cd ~/Google\ Drive/My\ Drive/vaults && stow .

# suppress prompt
cd
touch .hushlogin
```
