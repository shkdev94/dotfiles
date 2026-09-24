{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };
    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
    };

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
    homebrew-orca = {
      url = "github:stablyai/homebrew-orca";
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
      homebrew-orca,
      pyproject-nix,
      uv2nix,
      pyproject-build-systems,
    }:
    let
      browserUse =
        pkgs:
        import ./packages/python/browser-use {
          inherit
            pkgs
            pyproject-nix
            uv2nix
            pyproject-build-systems
            ;
        };
      codexAuth = pkgs: pkgs.callPackage ./packages/node/codex-auth { };
      configuration =
        { pkgs, config, ... }:
        {
          environment.systemPackages = with pkgs; [
            vim
            ripgrep
            mise
            corepack
            uv
            (browserUse pkgs)
            (codexAuth pkgs)
            awscli2
            gh
            pigz
            # Docker: colima provides the Linux VM/daemon, the rest are CLI-side
            colima
            docker-client
            docker-compose
            docker-buildx
          ];

          # colima has no login item of its own, so start the VM at login
          launchd.user.agents.colima = {
            command = "${pkgs.colima}/bin/colima start";
            serviceConfig = {
              RunAtLoad = true;
              StandardOutPath = "${config.users.users.sanghyeon.home}/Library/Logs/colima.log";
              StandardErrorPath = "${config.users.users.sanghyeon.home}/Library/Logs/colima.log";
            };
          };

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
              "stablyai/homebrew-orca" = homebrew-orca;
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
            ];

            casks = [
              "stablyai/orca/orca"
              "ghostty"
              "font-jetbrains-mono-nerd-font"
              "google-chrome"
              "visual-studio-code"
              "android-studio"
              "aldente"
              "chatgpt"
              "codex"
              "karabiner-elements"
              "logi-options+"
              "obsidian"
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
      packages.aarch64-darwin.browser-use = browserUse nixpkgs.legacyPackages.aarch64-darwin;
      packages.aarch64-darwin.codex-auth = codexAuth nixpkgs.legacyPackages.aarch64-darwin;

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
