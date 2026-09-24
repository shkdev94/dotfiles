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
in
# Expose only browser-use's commands; its Python stays private to this package.
mkApplication {
  venv = pythonSet.mkVirtualEnv "browser-use-env" { browser-use = [ ]; };
  package = pythonSet.browser-use;
}
