export EDITOR="vim"

# keybindings
bindkey '^F' autosuggest-accept

# aliases
alias c=claude --dangerously-skip-permissions
alias nxr="sudo darwin-rebuild switch --flake ~/.dotfiles#mbp"
alias nxu="nix flake update --flake ~/.dotfiles"
alias lzd=lazydocker

# fnm
eval "$(fnm env --use-on-cd --shell zsh)"

# rbenv
eval "$(rbenv init - zsh)"
export PATH="$HOME/.rbenv/bin:$PATH"

# sdkman
export SDKMAN_DIR=$(brew --prefix sdkman-cli)/libexec
[[ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]] && source "$SDKMAN_DIR/bin/sdkman-init.sh"

# android
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools

# claude
export PATH="$HOME/.local/bin:$PATH"
