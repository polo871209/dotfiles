{ pkgs, ... }: {
  # The packages installed here are available to all users, and are reproducible across machines, and are rollbackable.
  # But on macOS, it's less stable than homebrew.
  # Related Discussion: https://discourse.nixos.org/t/darwin-again/29331
  nixpkgs.config.allowUnfree = true;

  environment.systemPackages = [
    pkgs.atuin
    pkgs.bat
    pkgs.cargo
    pkgs.carapace
    pkgs.colima
    pkgs.crane
    pkgs.direnv
    pkgs.dive
    pkgs.docker-client
    pkgs.docker-slim
    pkgs.eza
    pkgs.fastfetch
    pkgs.fd
    pkgs.fzf
    pkgs.git
    (pkgs.google-cloud-sdk.withExtraComponents [pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin])
    pkgs.go
    pkgs.goose
    pkgs.jq
    pkgs.just
    pkgs.k9s
    pkgs.kubectl
    pkgs.kubectx
    pkgs.kubernetes-helm
    pkgs.kustomize
    pkgs.lazygit
    pkgs.neovim
    pkgs.nerd-fonts.jetbrains-mono
    pkgs.nerd-fonts.meslo-lg
    pkgs.nerd-fonts.symbols-only
    pkgs.nodejs_22
    pkgs.obsidian
    pkgs.oh-my-posh
    pkgs.poetry
    pkgs.python3Full
    pkgs.qmk
    pkgs.ripgrep
    pkgs.ruff
    pkgs.shellcheck
    pkgs.slack
    pkgs.sqlc
    pkgs.stow
    pkgs.tcping-go
    pkgs.terraform
    pkgs.tldr
    pkgs.tmux
    pkgs.tmuxp
    pkgs.tree
    pkgs.uv
    pkgs.vscode
    pkgs.wget
    pkgs.yq
    pkgs.zip
    pkgs.zoxide
    pkgs.zsh-completions
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
      PDFGear = 6469021132;
    };

    taps = [
      "homebrew/services"
    ];

    # `brew install`
    brews = [
      "awscli"
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
      "ghostty"
      "google-drive"
      "hiddenbar"
      "hyperkey"
      "raycast"
    ];
  };
}
