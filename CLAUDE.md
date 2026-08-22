# CLAUDE.md

## Project Overview

macOS dotfiles managed with **nix-darwin**, **home-manager**, and **nix-homebrew** on Apple Silicon (aarch64-darwin).

## Structure

- `flake.nix` — Main flake: system packages, macOS defaults, Homebrew (brews/casks/masApps), nix-darwin config
- `home.nix` — Home-manager: user programs (zsh, git, vim, yazi), dotfile symlinks via `mkOutOfStoreSymlink`
- `zshrc` — Zsh config loaded by home-manager's `initContent`; contains aliases, env vars, tool inits (fnm, rbenv, sdkman)
- `karabiner.json` — Karabiner Elements config, symlinked to `~/.config/karabiner/` via home-manager
- `tmux/` — tmux config, symlinked to `~/.config/tmux/`. `tmux.conf` plus `bin/wt-*` zsh scripts for the worktree picker popup (`prefix+Space`): `wt-list` collects worktrees grouped by repo, `wt-open` switches to / creates the session, `wt-picker` is the fzf UI. Scripts are executed directly, so they need their shebang
- `flake.lock` — Locked flake inputs (do not edit manually)

## Applying Changes

```sh
darwin-rebuild switch --flake ~/.dotfiles
```

## Conventions

- nix vs Homebrew: default to nix (`environment.systemPackages` in `flake.nix`) for anything in nixpkgs that builds on darwin — it is pinned by `flake.lock` and rollbackable. Use Homebrew for GUI apps (`homebrew.casks`), things missing or broken in nixpkgs, and tools with their own version managers/taps (sdkman, fnm, rbenv, cocoapods). Terminal UX tools (bat, zoxide, ripgrep, fd, fzf, yazi) live in nix; the remaining CLI brews (gh, awscli, uv, biome, prettierd, git-delta, pigz) are intentionally still on Homebrew — do not migrate them unless asked
- Mac App Store apps go in `homebrew.masApps` (name = App Store ID)
- User-level programs (with dotfile config) go in `home.nix` using `programs.<name>`
- Dotfiles stored in this repo are symlinked via `mkOutOfStoreSymlink` (not copied), so edits to source files take effect immediately
- Format nix files with `nixpkgs-fmt`
- The machine configuration is named `mbp` (`darwinConfigurations.mbp`)
