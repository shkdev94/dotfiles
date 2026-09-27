# OpenCode Git sidebar

OpenCode V2 CLI plugin that replaces the right sidebar's built-in content with
the current session's Git changes. Conflicts, staged, unstaged, and untracked files are listed by default;
files with both staged and unstaged edits appear in both groups. The heading
counts distinct uncommitted files and shows upstream ahead/behind counts when
available.

The plugin refreshes every three seconds while the sidebar is mounted. It uses
`git status` without modifying the working tree and shows an unavailable state
outside a Git repository. OpenCode discovers it automatically through
`~/.config/opencode/plugins/git-status`; no `cli.json` entry is needed. Run
`npm test --prefix opencode/plugins/git-status` from the dotfiles root to check
the status parser. Apply the Home Manager link with `nxr` when ready.
