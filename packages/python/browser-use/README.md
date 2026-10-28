# Isolated browser-use MCP

The Nix package pins browser-use and exports two commands:

- `browser-use`: the unchanged upstream CLI, including `--mcp` and `--cli-mcp`.
- `browser-use-mcp`: the dotfiles-owned launcher used by Pi.

The launcher keeps the upstream `--mcp` tools, but overrides the loaded browser
configuration in memory. It selects headless Google Chrome, disables reuse of an
existing CDP browser, and passes `user_data_dir=None` directly to the SDK. The
SDK creates a distinct temporary profile for each new browser session. This is
a custom integration, not an upstream MCP command or configuration recommendation.

The pinned MCP implementation otherwise defaults to
`~/.config/browseruse/profiles/default`. Setting `user_data_dir` to JSON `null`
in its configuration does not override that default because its config loader
omits null values.

## Lifetime and authentication

Each MCP process owns a private runtime directory. SDK temporary files and
extraction workspace files stay under that directory. Browsers remain available
for multiple tool calls until explicitly closed, timed out, or disconnected.
On normal disconnect, SIGINT, or SIGTERM, the launcher stops its idle cleanup
task, closes its owned browser sessions, and then removes its runtime directory.
A failed shutdown retains the directory and reports `MCP_CLEANUP_FAILED`; SIGKILL
and machine crashes cannot guarantee cleanup. Existing user browsers and profiles
are never adopted or deleted.

Other settings, including the configured LLM, allowed domains, viewport,
downloads, and an explicit `storage_state`, continue to load from the upstream
configuration (`~/.config/browseruse/config.json`, or `BROWSER_USE_CONFIG_PATH`).
Downloads outside the runtime directory are not removed. The browser executable,
CDP connection, headless mode, profile path, keep-alive setting, and extraction
workspace are owned by this launcher rather than the shared configuration.

Without an explicit saved authentication state, a new session starts logged out.
A logged-in session remains logged in while that browser stays open. If persistent
authentication is needed, keep `storage_state` outside this repository and treat
it as a secret. Do not commit cookies, credentials, runtime profiles, or tokens.
For a persistent profile or an existing browser connection, configure a separate
upstream `browser-use --mcp` instance rather than changing this launcher's lifetime.

## Build and activate

From the dotfiles repository:

```sh
# This also runs the offline launcher lifecycle tests.
nix build .#browser-use

# Include new files before they are tracked by Git.
nix build 'path:.#browser-use'

# Activate the Nix package before reconnecting clients.
nxr
```

Until the new files are tracked by Git, activate with
`sudo darwin-rebuild switch --flake "path:$HOME/.dotfiles#mbp"` instead of `nxr`
so Nix includes those files.

Pi's `pi/mcp-adapter.json` selects
`/run/current-system/sw/bin/browser-use-mcp`. After activation, use Pi's `/reload`.
Changing the linked client configuration alone does not install the new command.
No Python dependency or lock-file update is required.
