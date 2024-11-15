# Init New Mac

```bash
git clone https://github.com/polo871209/dotfiles.git
sh <(curl -L https://nixos.org/nix/install)
nix run nix-darwin --extra-experimental-features "nix-command flakes" -- switch --flake ~/dotfiles/nix
darwin-rebuild switch --extra-experimental-features "nix-command flakes"  --flake ~/dotfiles/nix
cat ~/dotfiles/dot_zshenv >| ~/.zshenv
stow .
```
