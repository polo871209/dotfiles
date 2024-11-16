{ pkgs, pkgs-neovim,  ... }: {

  ##########################################################################
  #
  #  Install all apps and packages here.
  #
  # TODO Fell free to modify this file to fit your needs.
  #
  ##########################################################################

  # Install packages from nix's official package repository.
  #
  # The packages installed here are available to all users, and are reproducible across machines, and are rollbackable.
  # But on macOS, it's less stable than homebrew.
  #
  # Related Discussion: https://discourse.nixos.org/t/darwin-again/29331
  nixpkgs.config.allowUnfree = true;
  environment.systemPackages = [
    # Development Tools
    pkgs-neovim.neovim
    pkgs.vscode
    pkgs.tmux
    pkgs.tmuxp
    pkgs.cargo
    pkgs.go
    pkgs.lazygit
    pkgs.poetry
    pkgs.sqlc
    pkgs.qmk

    # Languages
    pkgs.nodejs_22
    pkgs.python3
    pkgs.go

    # CLI Utilities & Tools
    pkgs.bat
    pkgs.carapace
    pkgs.eza
    pkgs.fzf
    pkgs.git
    pkgs.goose
    pkgs.just
    pkgs.ripgrep
    pkgs.superfile
    pkgs.unixtools.watch
    pkgs.fastfetch
    pkgs.mkalias
    pkgs.nushell
    pkgs.sqlc
    pkgs.tcping-go
    pkgs.terraform
    pkgs.tree
    pkgs.wezterm
    pkgs.wget
    pkgs.jq
    pkgs.yq
    pkgs.zip
    pkgs.zsh-completions

    # Cloud, DevOps, & Infrastructure
    pkgs.awscli2
    pkgs.direnv
    pkgs.dive
    pkgs.docker-client
    pkgs.docker-slim
    (pkgs.google-cloud-sdk.withExtraComponents [pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin])
    pkgs.kubectl
    pkgs.kubernetes-helm
    pkgs.kubectx
    pkgs.kustomize
    pkgs.k9s
    pkgs.colima

    # Productivity & Workflow
    pkgs.atuin
    pkgs.obsidian
    pkgs.oh-my-posh
    pkgs.slack
    pkgs.zoxide

    # Miscellaneous
    pkgs.bruno
    pkgs.nerdfonts
  ];

  environment.variables.EDITOR = "nvim";

  # TODO To make this work, homebrew need to be installed manually, see https://brew.sh
  #
  # The apps installed by homebrew are not managed by nix, and not reproducible!
  # But on macOS, homebrew has a much larger selection of apps than nixpkgs, especially for GUI apps!
  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true; # Fetch the newest stable branch of Homebrew's git repo
      upgrade = true; # Upgrade outdated casks, formulae, and App Store apps
      cleanup = "zap";
    };

    # Applications to install from Mac App Store using mas.
    # You need to install all these Apps manually first so that your apple account have records for them.
    # otherwise Apple Store will refuse to install them.
    # For details, see https://github.com/mas-cli/mas
    masApps = {
      Xnip = 1221250572;
    };

    taps = [
      "homebrew/services"
    ];

    # `brew install`
    brews = [
      "mas"
      "zsh-autosuggestions"
      "zsh-syntax-highlighting"
    ];

    # `brew install --cask`
    casks = [
      "alt-tab"
      "arc"
      "betterdisplay"
      "chatgpt"
      "dbeaver-community"
      "hiddenbar"
      "hyperkey"
      "raycast"
    ];
  };
}
