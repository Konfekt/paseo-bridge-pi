{
  lib,
  stdenvNoCC,
  src ? ../.,
}:
stdenvNoCC.mkDerivation {
  pname = "paseo-bridge-pi";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  src = lib.cleanSource src;
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r extension shim plugin scripts package.json README.md "$out/"
    runHook postInstall
  '';
  passthru = {
    # These sources are loaded by Pi and Paseo respectively, not bundled here.
    runtimeDependencies = [
      "nodejs >=22"
      "Pi extension SDK (provided by Pi)"
      "Paseo plugin SDK and client dependencies (provided by Paseo)"
    ];
  };
  meta = {
    description = "Pi extension, provider shim, and native Paseo permission-gate plugin sources";
    homepage = "https://github.com/taugoust/paseo-bridge-pi";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
}
