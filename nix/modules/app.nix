{ pkgs, pkgs-neovim,  ... }: {
  # The packages installed here are available to all users, and are reproducible across machines, and are rollbackable.
  # But on macOS, it's less stable than homebrew.
  # Related Discussion: https://discourse.nixos.org/t/darwin-again/29331
  nixpkgs.config.allowUnfree = true;

  environment.systemPackages = [
    # Development & Infrastructure
    pkgs.awscli2
    pkgs.bruno
    pkgs.cargo
    pkgs.colima
    pkgs.crane
    pkgs.direnv
    pkgs.dive
    pkgs.docker-client
    pkgs.docker-slim
    pkgs.git
    pkgs.go
    (pkgs.google-cloud-sdk.withExtraComponents [pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin])
    pkgs.goose
    pkgs.k9s
    pkgs.kubectl
    pkgs.kubectx
    pkgs.kubernetes-helm
    pkgs.kustomize
    pkgs.lazygit
    pkgs.nodejs_22
    pkgs-neovim.neovim
    pkgs.poetry
    pkgs.python313Full
    pkgs.sqlc
    pkgs.terraform
    pkgs.tmux
    pkgs.tmuxp
    pkgs.vscode

    # System & CLI Tools
    pkgs.atuin
    pkgs.bat
    pkgs.carapace
    pkgs.eza
    pkgs.fastfetch
    pkgs.fzf
    pkgs.jq
    pkgs.just
    pkgs.mkalias
    pkgs.nerd-fonts.jetbrains-mono
    pkgs.nerd-fonts.meslo-lg
    pkgs.nerd-fonts.symbols-only
    pkgs.nushell
    pkgs.oh-my-posh
    pkgs.ripgrep
    pkgs.stow
    pkgs.superfile
    pkgs.tcping-go
    pkgs.tree
    pkgs.unixtools.watch
    pkgs.wezterm
    pkgs.wget
    pkgs.zip
    pkgs.zoxide
    pkgs.zsh-completions

    # Applications
    pkgs.obsidian
    pkgs.qmk
    pkgs.slack
  ];

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
      "python@3.10"
      "yq"
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
