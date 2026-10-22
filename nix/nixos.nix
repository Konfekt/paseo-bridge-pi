{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.paseo-bridge-pi;
  integration = import ./integration.nix { inherit pkgs cfg; };
in
{
  options.programs.paseo-bridge-pi = import ./options.nix { inherit lib pkgs; };
  config = lib.mkIf cfg.enable {
    programs.paseo-bridge-pi.integration = integration;
    environment.systemPackages = [
      integration.rpcPackage
      integration.shimPackage
    ];
    environment.sessionVariables = integration.environment;
    assertions = [
      {
        assertion = !cfg.topology.enable || pkgs.stdenv.hostPlatform.isLinux;
        message = "paseo-bridge-pi topology is Linux-only";
      }
    ];
  };
}
