{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };
    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };
    homebrew-sdkman = {
      url = "github:sdkman/homebrew-tap";
      flake = false;
    };
    homebrew-hashicorp = {
      url = "github:hashicorp/homebrew-tap";
      flake = false;
    };
  };

  outputs =
    inputs@{
      self,
      nix-darwin,
      nixpkgs,
      home-manager,
      nix-homebrew,
      homebrew-core,
      homebrew-cask,
      homebrew-sdkman,
      homebrew-hashicorp,
    }:
    let
      configuration =
        { pkgs, config, ... }:
        {
          environment.systemPackages = with pkgs; [
            vim
          ];

          nix.settings.experimental-features = "nix-command flakes";

          nixpkgs.hostPlatform = "aarch64-darwin";

          system.configurationRevision = self.rev or self.dirtyRev or null;

          system.stateVersion = 6;

          system.primaryUser = "sanghyeon";

          security.pam.services.sudo_local.touchIdAuth = true;

          system.defaults = {
            NSGlobalDomain.ApplePressAndHoldEnabled = false;
            NSGlobalDomain."com.apple.sound.beep.volume" = 0.0;
            NSGlobalDomain.AppleInterfaceStyle = "Dark";

            finder.AppleShowAllFiles = true;
            finder.AppleShowAllExtensions = true;

            screencapture.location = "~/Pictures/Screenshots";

            dock = {
              autohide = true;
              mru-spaces = false;
              persistent-apps = [ ];
            };
          };

          nix-homebrew = {
            enable = true;
            user = "sanghyeon";

            taps = {
              "homebrew/homebrew-core" = homebrew-core;
              "homebrew/homebrew-cask" = homebrew-cask;
              "sdkman/homebrew-tap" = homebrew-sdkman;
              "hashicorp/homebrew-tap" = homebrew-hashicorp;
            };

            mutableTaps = false;

          };

          homebrew = {
            enable = true;
            onActivation = {
              autoUpdate = true;
              upgrade = true;
              cleanup = "zap";
            };
            taps = builtins.attrNames config.nix-homebrew.taps;
            brews = [
              "mas"
              "fnm"
              "rbenv"
              "cocoapods"
              "sdkman/tap/sdkman-cli"
              "bat"
              "zoxide"
              "ripgrep"
              "fd"
              "fzf"
              "uv"
              "yazi"
              "git-delta"
              "hashicorp/tap/terraform"
              "awscli"
              "gh"
              "biome"
              "prettierd"
              # lomin
              "pigz"
            ];

            casks = [
              "ghostty"
              "font-jetbrains-mono-nerd-font"
              "google-chrome"
              "visual-studio-code"
              "android-studio"
              "aldente"
              "chatgpt"
              "claude"
              "claude-code"
              "codex"
              "karabiner-elements"
              "docker-desktop"
              "logi-options+"
              "figma"
              "slack"
            ];

            masApps = {
              KakaoTalk = 869223134;
              CleanMyMac = 1339170533;
              Xcode = 497799835;
            };
          };
        };
    in
    {
      darwinConfigurations.mbp = nix-darwin.lib.darwinSystem {
        modules = [
          nix-homebrew.darwinModules.nix-homebrew
          configuration
          home-manager.darwinModules.home-manager
          {
            users.users.sanghyeon.home = "/Users/sanghyeon";
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.backupFileExtension = "bak";
            home-manager.users.sanghyeon = import ./home.nix;
          }
        ];
      };
    };
}
