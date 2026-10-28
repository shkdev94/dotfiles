{
  pkgs,
  pyproject-nix,
  uv2nix,
  pyproject-build-systems,
}:
let
  workspace = uv2nix.lib.workspace.loadWorkspace {
    workspaceRoot = ./.;
  };
  pythonSet =
    (pkgs.callPackage pyproject-nix.build.packages {
      python = pkgs.python313;
    }).overrideScope
      (
        pkgs.lib.composeManyExtensions [
          pyproject-build-systems.overlays.wheel
          (workspace.mkPyprojectOverlay { sourcePreference = "wheel"; })
        ]
      );
  inherit (pkgs.callPackages pyproject-nix.build.util { }) mkApplication;
  venv = pythonSet.mkVirtualEnv "browser-use-env" { browser-use = [ ]; };
  application = mkApplication {
    inherit venv;
    package = pythonSet.browser-use;
  };
  mcpLauncher = pkgs.writeShellScriptBin "browser-use-mcp" ''
    exec ${venv}/bin/python ${./mcp-launcher.py} "$@"
  '';
in
# Expose browser-use and its isolated MCP launcher, but not the private Python.
pkgs.symlinkJoin {
  name = application.name;
  paths = [
    application
    mcpLauncher
  ];
  meta = application.meta;
  postBuild = ''
    export BROWSER_USE_CONFIG_DIR="$TMPDIR/browser-use-test-config"
    export ANONYMIZED_TELEMETRY=false
    export BROWSER_USE_CLOUD_SYNC=false
    export PYTHONDONTWRITEBYTECODE=1
    ${venv}/bin/python -m unittest discover \
      --start-directory ${./.} --pattern test_mcp_launcher.py --verbose
  '';
}
