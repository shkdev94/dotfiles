{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs,
  makeWrapper,
  curl,
  versionCheckHook,
}:
let
  package = lib.importJSON ./package.json;
in
buildNpmPackage {
  pname = "codex-auth";
  version = package.dependencies."@loongphy/codex-auth";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
    ];
  };

  inherit nodejs;
  npmDeps = importNpmLock { npmRoot = ./.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  # The npm launcher selects the platform binary from its optional dependencies.
  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/codex-auth" "$out/bin"
    cp -R node_modules "$out/lib/codex-auth/"
    makeWrapper ${lib.getExe nodejs} "$out/bin/codex-auth" \
      --add-flags "$out/lib/codex-auth/node_modules/@loongphy/codex-auth/bin/codex-auth.js" \
      --prefix PATH : ${lib.makeBinPath [ curl ]}

    runHook postInstall
  '';

  nativeInstallCheckInputs = [ versionCheckHook ];
  versionCheckProgramArg = "--version";
  doInstallCheck = true;

  meta = {
    description = "CLI for switching Codex accounts";
    homepage = "https://github.com/Loongphy/codex-auth";
    license = lib.licenses.mit;
    mainProgram = "codex-auth";
    platforms = [ "aarch64-darwin" ];
  };
}
