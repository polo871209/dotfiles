{
  description = "Polohi Darwin system flake";

  # Ref: https://github.com/ryan4yin/nix-darwin-kickstarter

  # This is the standard format for flake.nix. `inputs` are the dependencies of the flake,
  # Each item in `inputs` will be passed as a parameter to the `outputs` function after being pulled and built.
  inputs = {
    nixpkgs-darwin.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    # To install a specific version of a package, find its hash at: https://www.nixhub.io
    darwin = {
      url = "github:lnl7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs-darwin";
    };
  };

  # The `outputs` function will return all the build results of the flake.
  # A flake can have many use cases and different types of outputs,
  # parameters in `outputs` are defined in `inputs` and can be referenced by their names.
  # However, `self` is an exception, this special parameter points to the `outputs` itself (self-reference)
  # The `@` syntax here is used to alias the attribute set of the inputs's parameter, making it convenient to use inside the function.
  outputs = inputs @ {
    self,
    nixpkgs,
    darwin,
    ...
  }: let

    username = "polo";
    useremail = "qazh0123@gmail.com";
    system = "aarch64-darwin";
    hostname = "polohi";

    specialArgs =
      inputs
      // {
        inherit username useremail hostname;
      };
  in
  {
    # Build darwin flake using:
    # darwin-rebuild switch --flake ~/dotfiles/nix
    darwinConfigurations."${hostname}" = darwin.lib.darwinSystem {
      inherit specialArgs;
      modules = [
          ./modules/nix-core.nix
          ./modules/system.nix
          ./modules/app.nix
          ./modules/host-users.nix
      ];
    };

    # nix code formatter
    formatter.${system} = nixpkgs.legacyPackages.${system}.alejandra;
  };
}
