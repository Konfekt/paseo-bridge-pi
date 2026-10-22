# No flake inputs are needed when called directly with the consumer's pkgs.
{
  pkgs,
  package ? pkgs.callPackage ./package.nix { src = ../.; },
  nodejs ? pkgs.nodejs_22,
  paseoPackage,
  host ? null,
  passwordFile ? null,
  autoConnect ? true,
  importSessions ? true,
  generateTitles ? true,
  debug ? false,
  topology ? false,
  rootTrustMode,
  supervisedLauncher,
  unsafeLauncher,
  startTimeoutMs ? 120000,
  rpcExecutable,
  permissionGateExtension,
  rpcExtensions,
}:
let
  inherit (pkgs) lib;
  absolute = value: builtins.isString value && lib.hasPrefix "/" value;
  flag = value: if value then "1" else "0";
  extensionPath = "${package}/extension/index.ts";
  pluginPath = "${package}/plugin";
  environment = {
    PASEO_CLI = "${paseoPackage}/bin/paseo";
    PASEO_TMUX_TOPOLOGY = flag topology;
    PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT = flag autoConnect;
    PI_PASEO_BRIDGE_IMPORT_SESSIONS = flag importSessions;
    PI_PASEO_BRIDGE_GENERATE_TITLES = flag generateTitles;
    PI_PASEO_BRIDGE_DEBUG = flag debug;
    PI_PASEO_ROOT_TUI_KIND = rootTrustMode;
    PI_PASEO_TUI_BIN = supervisedLauncher;
    PI_PASEO_UNSAFE_TUI_BIN = unsafeLauncher;
    PI_PASEO_FORK_START_TIMEOUT_MS = toString startTimeoutMs;
  }
  // lib.optionalAttrs (host != null) { PASEO_HOST = host; }
  // lib.optionalAttrs (passwordFile != null) { PASEO_PASSWORD_FILE = passwordFile; };
  exports = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") environment
  );
  rpcPackage = pkgs.writeShellScriptBin "pi-paseo" ''
    ${exports}
    # Disable discovery to avoid Pi dropping early RPC commands. Permission
    # gating and providers must therefore be explicit, never inherited.
    exec ${lib.escapeShellArg rpcExecutable} --no-extensions \
      ${
        lib.escapeShellArgs (
          lib.concatMap
            (extension: [
              "--extension"
              extension
            ])
            (
              lib.unique (
                [
                  permissionGateExtension
                  extensionPath
                ]
                ++ rpcExtensions
              )
            )
        )
      } "$@"
  '';
  shimPackage = pkgs.writeShellScriptBin "pi-paseo-shim" ''
    ${exports}
    export PI_REAL_BIN=${rpcPackage}/bin/pi-paseo
    exec ${nodejs}/bin/node ${package}/shim/pi-paseo-shim.js "$@"
  '';
in
assert lib.assertMsg (builtins.elem rootTrustMode [
  "supervised"
  "unsafe"
]) "rootTrustMode must be supervised or unsafe";
assert lib.assertMsg (
  !topology || pkgs.stdenv.hostPlatform.isLinux
) "Topology is supported only on Linux";
assert lib.assertMsg (!topology || rootTrustMode == "unsafe")
  "Topology roots currently require explicit unsafe trust; supervised forks retain their source trust";
assert lib.assertMsg (lib.all absolute (
  [
    rpcExecutable
    supervisedLauncher
    unsafeLauncher
    permissionGateExtension
  ]
  ++ rpcExtensions
)) "All launchers and explicit RPC extensions must be absolute paths";
assert lib.assertMsg (
  passwordFile == null || (absolute passwordFile && !lib.hasPrefix "/nix/store/" passwordFile)
) "passwordFile must reference a runtime secret outside the Nix store";
assert lib.assertMsg (builtins.isList rpcExtensions)
  "rpcExtensions must be an explicit list (including provider extensions); use [] deliberately";
assert lib.assertMsg (
  builtins.isInt startTimeoutMs && startTimeoutMs >= 1000 && startTimeoutMs <= 600000
) "startTimeoutMs must be between 1000 and 600000";
{
  inherit
    package
    rpcPackage
    shimPackage
    environment
    extensionPath
    pluginPath
    ;
  providerCommand = [ "${shimPackage}/bin/pi-paseo-shim" ];
  pluginSettings.paseo-permission-gate = {
    source = "directory";
    path = pluginPath;
    enabled = true;
  };
}
