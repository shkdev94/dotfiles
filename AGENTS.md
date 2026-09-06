# Agent Instructions

## Project Overview

macOS dotfiles managed with **nix-darwin**, **home-manager**, and **nix-homebrew** on Apple Silicon (aarch64-darwin).

## Structure

- `flake.nix` — Main flake: system packages, macOS defaults, Homebrew (brews/casks/masApps), nix-darwin config
- `home.nix` — Home-manager: user programs (zsh, git, vim), dotfile symlinks via `mkOutOfStoreSymlink`
- `zshrc` — Zsh config loaded by home-manager's `initContent`; contains aliases, env vars, and mise activation
- `karabiner.json` — Karabiner Elements config, symlinked to `~/.config/karabiner/` via home-manager
- `mise/` — Global mise tool versions for Node.js, Ruby, Java, Terraform, and CocoaPods
- `flake.lock` — Locked flake inputs (do not edit manually)

## Applying Changes

```sh
darwin-rebuild switch --flake ~/.dotfiles
```

## Conventions

- Install CLI tools with nix (`environment.systemPackages` in `flake.nix`) so they are pinned by `flake.lock` and rollbackable. Runtime and tool versions that vary by project are managed by mise. Homebrew is reserved for GUI apps (`homebrew.casks`) and Mac App Store automation (`mas`).
- Mac App Store apps go in `homebrew.masApps` (name = App Store ID)
- User-level programs (with dotfile config) go in `home.nix` using `programs.<name>`
- Dotfiles stored in this repo are symlinked via `mkOutOfStoreSymlink` (not copied), so edits to source files take effect immediately
- Format nix files with `nixfmt`
- The machine configuration is named `mbp` (`darwinConfigurations.mbp`)
