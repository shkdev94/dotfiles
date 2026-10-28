{
  lib,
  buildNpmPackage,
  importNpmLock,
  pi-coding-agent,
}:
buildNpmPackage {
  pname = "pi-extensions";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
    ];
  };

  npmDeps = importNpmLock { npmRoot = ./.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmFlags = [ "--legacy-peer-deps" ];
  npmRebuildFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/pi-extensions"
    cp -R node_modules "$out/share/pi-extensions/"

    # Use the host's SDK for all extensions, including detached subagents.
    host=${pi-coding-agent}/lib/node_modules/pi-monorepo
    modules="$out/share/pi-extensions/node_modules"
    mkdir -p "$modules/@earendil-works"
    # SDK packages can be added or removed between host releases.
    for package in "$host"/node_modules/@earendil-works/pi-*; do
      ln -s "$package" "$modules/@earendil-works/$(basename "$package")"
    done
    ln -s "$host" "$modules/@earendil-works/pi-coding-agent"
    ln -s "$host/node_modules/typebox" "$modules/typebox"

    runHook postInstall
  '';

  meta = {
    description = "Pinned Pi extensions for subagents, MCP, OAuth account switching, and web access";
    license = lib.licenses.mit;
    platforms = [ "aarch64-darwin" ];
  };
}
