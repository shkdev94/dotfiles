export EDITOR="vim"

# keybindings
bindkey '^F' autosuggest-accept

# aliases
alias c=claude --dangerously-skip-permissions
alias nxr="sudo darwin-rebuild switch --flake ~/.dotfiles#mbp"
alias nxu="nix flake update --flake ~/.dotfiles"
alias lzd=lazydocker

# mise
eval "$(mise activate zsh)"

# android
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools

# claude
export PATH="$HOME/.local/bin:$PATH"
