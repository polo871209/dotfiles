{
  description = "Polohi Darwin system flake";

  ##################################################################################################################
  #
  # Ref: https://github.com/ryan4yin/nix-darwin-kickstarter
  #      https://www.youtube.com/watch?v=Z8BL8mdzWHI&t=1303s
  #
  ##################################################################################################################

  # the nixConfig here only affects the flake itself, not the system configuration!
  nixConfig = {
    substituters = [
      # Query the mirror of USTC first, and then the official cache.
      "https://mirrors.ustc.edu.cn/nix-channels/store"
      "https://cache.nixos.org"
    ];
  };

  # This is the standard format for flake.nix. `inputs` are the dependencies of the flake,
  # Each item in `inputs` will be passed as a parameter to the `outputs` function after being pulled and built.
  inputs = {
    nixpkgs-darwin.url = "github:nixos/nixpkgs/nixpkgs-unstable";
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
    home-manager,
    ...
  }: let

    username = "polo";
    useremail = "qazh0123@gmail.com";
    system = "aarch64-darwin";
    hostname = "polohi";

    # username = "po.locp";
    # useremail = "qazh0123@gmail.com";
    # system = "aarch64-darwin";
    # hostname = "KJ9NCMV04M";


    specialArgs =
      inputs
      // {
        inherit username useremail hostname;
      };
  in
  {
    # Build darwin flake using:
    # $ darwin-rebuild switch --flake ~/.config/nix
    darwinConfigurations."${hostname}" = darwin.lib.darwinSystem {
      inherit specialArgs;
      modules = [
          ./modules/nix-core.nix
          ./modules/system.nix
          ./modules/app.nix
          ./modules/homebrew-mirror.nix
          ./modules/host-users.nix
      ];
    };

    # Expose the package set, including overlays, for convenience.
    darwinPackages = self.darwinConfigurations."polohi".pkgs;
    formatter.${system} = nixpkgs.legacyPackages.${system}.alejandra;
  };
}
