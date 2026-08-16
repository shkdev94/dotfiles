export EDITOR="vim"

# keybindings
bindkey '^F' autosuggest-accept

# aliases
alias f=fzf
alias c=claude --dangerously-skip-permissions
alias nxu="sudo nix flake update && sudo darwin-rebuild switch --flake ~/.dotfiles#mbp"

# yazi
function y() {
	local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
	command yazi "$@" --cwd-file="$tmp"
	IFS= read -r -d '' cwd < "$tmp"
	[ "$cwd" != "$PWD" ] && [ -d "$cwd" ] && builtin cd -- "$cwd"
	rm -f -- "$tmp"
}

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

# zoxide
eval "$(zoxide init zsh)"

# claude
export PATH="$HOME/.local/bin:$PATH"
