{ pkgs, ... }: {

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
  environment.systemPackages = with pkgs; [
    # Development Tools
    neovim
    vscode
    tmux
    cargo
    go
    lazygit
    poetry
    sqlc
    qmk

    # CLI Utilities & Tools
    eza
    bat
    bat-extras.batgrep
    fzf
    git
    just
    ripgrep
    unixtools.watch
    fastfetch
    tcping-go
    tree
    wget
    jq
    yq
    zip
    # completions
    nix-zsh-completions
    zsh-completions

    # Cloud, DevOps, & Infrastructure
    awscli2
    google-cloud-sdk
    kubectl
    kubernetes-helm
    kubectx
    k9s
    colima
    docker-slim

    # Productivity & Workflow
    obsidian
    oh-my-posh
    atuin
    zoxide
    chezmoi
    alttab

    # Database & Networking
    dbeaver-bin
    postman

    # Fonts & Aesthetic
    nerdfonts

    # Miscellaneousß
    wezterm
    mkalias
    python3
    goose
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
      # Xcode = 497799835;
    };

    taps = [
      "homebrew/services"
    ];

    # `brew install`
    brews = [
      "zsh-completions"
    ];

    # `brew install --cask`
    casks = [
      "alt-tab"
      "arc"
      "betterdisplay"
      "chatgpt"
      "hiddenbar"
      "hyper"
      "raycast"
    ];
  };
}
