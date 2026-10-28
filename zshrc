export EDITOR="nvim"

# keybindings
bindkey '^F' autosuggest-accept

# aliases
alias v='nvim'
alias lzg='lazygit'
alias lzd='lazydocker'
alias nxr="sudo darwin-rebuild switch --flake ~/.dotfiles#mbp"
alias nxu="nix flake update --flake ~/.dotfiles"

# android
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools

# Activate mise after other PATH changes so managed runtimes take precedence.
eval "$(mise activate zsh)"
