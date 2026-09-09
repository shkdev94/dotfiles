{
  config,
  pkgs,
  lib,
  ...
}:
let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  create_symlink = path: config.lib.file.mkOutOfStoreSymlink path;
  gh-attach = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "gh-attach";
    version = "0.4.3";

    src = pkgs.fetchurl {
      url = "https://github.com/sudosubin/gh-attach/releases/download/v${version}/gh-attach-darwin-arm64";
      hash = "sha256-gf7/Hi7GDAOJc/yUSH5cE3n66xjiApNZhbjNALbRUvU=";
    };

    dontUnpack = true;
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 "$src" "$out/bin/gh-attach"
      runHook postInstall
    '';

    meta = {
      description = "GitHub CLI extension for uploading and downloading attachments";
      homepage = "https://github.com/sudosubin/gh-attach";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  home.username = "sanghyeon";
  home.homeDirectory = "/Users/sanghyeon";
  home.stateVersion = "25.05";
  home.packages = with pkgs; [
    nixfmt
  ];

  programs.gh = {
    enable = true;
    gitCredentialHelper.enable = false;
    extensions = [
      gh-attach
      pkgs.gh-stack
    ];
  };

  home.file.".agent/skills/create-branch".source = create_symlink "${dotfiles}/skills/create-branch";
  home.file.".agent/skills/commit-changes".source =
    create_symlink "${dotfiles}/skills/commit-changes";
  home.file.".agent/skills/create-pr".source = create_symlink "${dotfiles}/skills/create-pr";
  home.file.".agent/skills/review-code".source = create_symlink "${dotfiles}/skills/review-code";
  home.file.".agent/skills/work-with-evidence".source =
    create_symlink "${dotfiles}/skills/work-with-evidence";

  home.file.".agents/skills/add-issue".source = create_symlink "${dotfiles}/skills/add-issue";
  home.file.".agents/skills/cleanup-merged-pr".source =
    create_symlink "${dotfiles}/skills/cleanup-merged-pr";
  home.file.".agents/skills/create-branch".source = create_symlink "${dotfiles}/skills/create-branch";
  home.file.".agents/skills/commit-changes".source =
    create_symlink "${dotfiles}/skills/commit-changes";
  home.file.".agents/skills/create-pr".source = create_symlink "${dotfiles}/skills/create-pr";
  home.file.".agents/skills/review-code".source = create_symlink "${dotfiles}/skills/review-code";
  home.file.".agents/skills/work-with-evidence".source =
    create_symlink "${dotfiles}/skills/work-with-evidence";
  home.file.".agents/skills/implement-issue".source =
    create_symlink "${dotfiles}/skills/implement-issue";
  home.file.".agents/skills/write-good-code".source =
    create_symlink "${dotfiles}/skills/write-good-code";
  home.file.".agents/skills/write-ui-unit-test".source =
    create_symlink "${dotfiles}/skills/write-ui-unit-test";
  home.file.".agents/skills/write-unit-test".source =
    create_symlink "${dotfiles}/skills/write-unit-test";

  xdg.configFile."karabiner/karabiner.json" = {
    source = create_symlink "${dotfiles}/karabiner.json";
    force = true;
  };

  xdg.configFile."ghostty" = {
    source = create_symlink "${dotfiles}/ghostty";
    force = true;
  };

  xdg.configFile."mise/config.toml" = {
    source = create_symlink "${dotfiles}/mise/config.toml";
    force = true;
  };

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    initContent = builtins.readFile ./zshrc;
  };

  programs.git = {
    enable = true;
    settings = {
      user = {
        name = "sanghyeon";
        email = "sanghyeon.dev@proton.me";
      };
      credential.helper = "store";
      push = {
        autoSetupRemote = true;
      };
      core.editor = "vim";
      merge.conflictstyle = "zdiff3";
    };
  };

  programs.vim = {
    enable = true;
    settings = {
      ignorecase = true;
      expandtab = true;
      tabstop = 2;
      shiftwidth = 2;
      number = true;
      mouse = "a";
    };
    extraConfig = ''
      set clipboard=unnamedplus
    '';
  };

  # docker CLI plugins live under libexec, which is not in docker's plugin
  # search path, so link them into ~/.docker/cli-plugins where it does look
  home.file.".docker/cli-plugins/docker-compose" = {
    source = "${pkgs.docker-compose}/libexec/docker/cli-plugins/docker-compose";
    force = true;
  };

  home.file.".docker/cli-plugins/docker-buildx" = {
    source = "${pkgs.docker-buildx}/libexec/docker/cli-plugins/docker-buildx";
    force = true;
  };

  programs.lazydocker.enable = true;
}
