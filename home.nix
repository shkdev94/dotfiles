{ config
, pkgs
, lib
, ...
}:
let
  dotfiles = "${config.home.homeDirectory}/.dotfiles";
  create_symlink = path: config.lib.file.mkOutOfStoreSymlink path;
in
{
  home.username = "sanghyeon";
  home.homeDirectory = "/Users/sanghyeon";
  home.stateVersion = "25.05";
  home.packages = with pkgs; [
    nixfmt-rfc-style
    nil # Nix LSP
  ];

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

  xdg.configFile."yazi" = {
    source = create_symlink "${dotfiles}/yazi";
    force = true;
  };

  xdg.configFile."tmux/tmux.conf" = {
    source = create_symlink "${dotfiles}/tmux.conf";
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
      push = { autoSetupRemote = true; };
      core.pager = "delta";
      interactive.diffFilter = "delta --color-only";
      delta = {
        navigate = true;
        side-by-side = true;
      };
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
}
