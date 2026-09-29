{
  config,
  pkgs,
  lib,
  herdr,
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

  home.file.".codex/dev.config.toml".source = create_symlink "${dotfiles}/codex/config.toml";
  home.file.".codex/agents".source = create_symlink "${dotfiles}/codex/agents";

  home.file.".agents/skills" = {
    source = create_symlink "${dotfiles}/codex/skills";
    force = true;
  };

  xdg.configFile."opencode/opencode.jsonc".source =
    create_symlink "${dotfiles}/opencode/opencode.jsonc";
  xdg.configFile."opencode/cli.json" = {
    source = create_symlink "${dotfiles}/opencode/cli.json";
    force = true;
  };
  xdg.configFile."opencode/AGENTS.md".source = create_symlink "${dotfiles}/opencode/AGENTS.md";
  xdg.configFile."opencode/agents".source = create_symlink "${dotfiles}/opencode/agents";
  xdg.configFile."opencode/plugins/git-status".source =
    create_symlink "${dotfiles}/opencode/plugins/git-status";
  xdg.configFile."opencode/skills".source = create_symlink "${dotfiles}/opencode/skills";

  home.file.".pi/agent/settings.json".source = create_symlink "${dotfiles}/pi/settings.json";
  home.file.".pi/agent/models.json".source = create_symlink "${dotfiles}/pi/models.json";
  home.file.".pi/agent/web-search.json".source = create_symlink "${dotfiles}/pi/web-search.json";
  home.file.".pi/agent/extensions/footer.ts".source =
    create_symlink "${dotfiles}/pi/extensions/footer.ts";
  home.file.".pi/agent/extensions/editor.ts".source =
    create_symlink "${dotfiles}/pi/extensions/editor.ts";
  # Use the exact official integration bundled with the pinned Herdr release.
  home.file.".pi/agent/extensions/herdr-agent-state.ts".source =
    "${herdr}/src/integration/assets/pi/herdr-agent-state.ts";
  home.file.".pi/agent/AGENTS.md".source = create_symlink "${dotfiles}/pi/AGENTS.md";
  home.file.".pi/agent/agents".source = create_symlink "${dotfiles}/pi/agents";
  home.file.".pi/agent/skills".source = create_symlink "${dotfiles}/pi/skills";
  home.file.".pi/agent/mcp-adapter.json".source = create_symlink "${dotfiles}/pi/mcp-adapter.json";
  home.file.".pi/agent/extensions/subagent/config.json".source =
    create_symlink "${dotfiles}/pi/subagents.json";
  home.file.".pi/agent/packages" = {
    source = "${pkgs.callPackage ./packages/node/pi-extensions { }}/share/pi-extensions/node_modules";
    # Take ownership of the generated link, including links from manual installs.
    force = true;
  };

  xdg.configFile."karabiner/karabiner.json" = {
    source = create_symlink "${dotfiles}/karabiner.json";
    force = true;
  };

  xdg.configFile."ghostty" = {
    source = create_symlink "${dotfiles}/ghostty";
    force = true;
  };

  xdg.configFile."nvim" = {
    source = create_symlink "${dotfiles}/nvim";
    force = true;
  };

  xdg.configFile."tmux" = {
    source = create_symlink "${dotfiles}/tmux";
    force = true;
  };

  xdg.configFile."herdr/config.toml".source = create_symlink "${dotfiles}/herdr/config.toml";
  xdg.configFile."herdr/bin/workspace".source = create_symlink "${dotfiles}/herdr/bin/workspace";

  xdg.configFile."mise/config.toml" = {
    source = create_symlink "${dotfiles}/mise/config.toml";
    force = true;
  };

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    profileExtra = ''
      eval "$(${pkgs.mise}/bin/mise activate zsh --shims)"
    '';

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
      core.editor = "nvim";
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

}
