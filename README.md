# Init New Mac

```bash
git clone https://github.com/polo871209/dotfiles.git

# set XDG_CONFIG_HOME
cat ~/dotfiles/dot_zshenv >| ~/.zshenv

# create config symlinks
stow .

# gen key and add to github
ssh-keygen -t ed25519

# setup notes(login google drive first)
mkdir ~/valuts && cd ~/Google\ Drive/My\ Drive/vaults && stow .

# supress prompt
cd
touch .hushlogin
```
