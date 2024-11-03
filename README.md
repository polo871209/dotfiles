# Init New Mac

```
sh -c "$(curl -fsLS get.chezmoi.io)" -- -b $HOME/Downloads && \
$HOME/Downloads/chezmoi init --apply https://github.com/polo871209/dotfiles.git && \
rm -rf $HOME/Downloads/chezmoi
```
