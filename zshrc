# bob (neovim version manager)
export PATH="$HOME/.local/share/bob/nvim-bin:$PATH"

export EDITOR="nvim"

# keybindings
bindkey '^F' autosuggest-accept

# aliases
alias v=nvim .
alias f=fzf
alias c=claude --dangerously-skip-permissions
alias nxu="sudo nix flake update && sudo darwin-rebuild switch --flake ~/.dotfiles#mbp"

# Coding cockpit: neovim + claude + terminal in tmux
tmx() {
  local raw_name="${1:-$(basename "$PWD")}"
  local session_name="${raw_name#.}"
  session_name="${session_name//./_}"

  if [[ -n "$TMUX" ]]; then
    echo "Already in a tmux session. Detach first or run from outside tmux."
    return 1
  fi

  if tmux has-session -t "$session_name" 2>/dev/null; then
    tmux attach-session -t "$session_name"
    return
  fi

  tmux new-session -s "$session_name" -c "$PWD" -x "$(tput cols)" -y "$(tput lines)"
}

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
