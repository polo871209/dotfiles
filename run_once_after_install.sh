sh <(curl -L https://nixos.org/nix/install)
sed -i '' "s/polohi/$(scutil --get LocalHostName)/" ~/.config/nix-darwin/flake.nix
nix run nix-darwin --extra-experimental-features "nix-command flakes" -- switch --flake ~/.config/nix-darwin
darwin-rebuild switch --extra-experimental-features "nix-command flakes"  --flake ~/.config/nix-darwin
