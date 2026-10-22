{ lib, pkgs }:
let
  inherit (lib) mkOption types;
  pathString = types.strMatching "/.*";
in
{
  enable = lib.mkEnableOption "the composable Pi/Paseo bridge";
  package = mkOption {
    type = types.package;
    default = pkgs.callPackage ./package.nix { src = ../.; };
    description = "Bridge source artifact, including extension, shim, and Paseo plugin.";
  };
  nodejs = mkOption {
    type = types.package;
    default = pkgs.nodejs_22;
  };
  paseoPackage = mkOption {
    type = types.package;
    description = "Native Paseo package providing the paseo CLI.";
  };
  host = mkOption {
    type = types.nullOr types.str;
    default = null;
    description = "Explicit native Paseo endpoint; null preserves native endpoint discovery.";
  };
  passwordFile = mkOption {
    type = types.nullOr pathString;
    default = null;
    description = "Runtime secret path (never a Nix path or literal password). Host owns provisioning and permissions.";
  };
  autoConnect = mkOption {
    type = types.bool;
    default = true;
    description = "Default auto-connect preference; mutable /paseo-bridge auto preference takes precedence.";
  };
  importSessions = mkOption {
    type = types.bool;
    default = true;
    description = "Allow automatic session import.";
  };
  generateTitles = mkOption {
    type = types.bool;
    default = true;
    description = "Allow generated session titles.";
  };
  debug = mkOption {
    type = types.bool;
    default = false;
  };
  topology.enable = mkOption {
    type = types.bool;
    default = false;
    description = "Use native Linux tmux topology. Requires an explicitly unsafe root launcher.";
  };
  rootTrustMode = mkOption {
    type = types.enum [
      "supervised"
      "unsafe"
    ];
    description = "Explicit root launch trust; never inferred from PATH or UI state.";
  };
  supervisedLauncher = mkOption {
    type = pathString;
    description = "Absolute supervised TUI executable; must retain the permission-gate launcher.";
  };
  unsafeLauncher = mkOption {
    type = pathString;
    description = "Absolute intentionally unsafe TUI executable, used only for unsafe source trust.";
  };
  startTimeoutMs = mkOption {
    type = types.ints.between 1000 600000;
    default = 120000;
  };
  rpcExecutable = mkOption {
    type = pathString;
    description = "Absolute Pi RPC executable, without shell arguments.";
  };
  permissionGateExtension = mkOption {
    type = pathString;
    description = "Mandatory permission-gate client extension; always explicitly loaded in RPC mode.";
  };
  rpcExtensions = mkOption {
    type = types.listOf pathString;
    description = "Required explicit provider/other RPC extension list. Discovery is disabled; [] is an explicit choice.";
  };
  integration = mkOption {
    type = types.attrs;
    readOnly = true;
    description = "Reusable artifacts: package, rpcPackage, shimPackage, environment, shimEnvironment, extensionPath, pluginPath, providerCommand, pluginSettings. Host merges the last two into native Paseo settings.";
  };
}
