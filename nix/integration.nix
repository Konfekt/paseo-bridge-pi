{ pkgs, cfg }:
import ./mk-bridge.nix {
  inherit pkgs;
  inherit (cfg)
    package
    nodejs
    paseoPackage
    host
    passwordFile
    autoConnect
    importSessions
    generateTitles
    debug
    rootTrustMode
    supervisedLauncher
    unsafeLauncher
    startTimeoutMs
    rpcExecutable
    permissionGateExtension
    rpcExtensions
    ;
  topology = cfg.topology.enable;
}
