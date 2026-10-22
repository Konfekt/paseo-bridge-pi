# Nix interface

Use one input, following your existing package set:

```nix
inputs.paseo-bridge-pi = {
  url = "github:taugoust/paseo-bridge-pi";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Exports:

- `packages.${system}.default` / `.paseo-bridge-pi`: unbundled Pi package,
  including `extension/`, `shim/`, and the native `plugin/` directory.
- `nixosModules.default` and `homeManagerModules.default`: same options under
  `programs.paseo-bridge-pi`; install RPC/shim wrappers and session variables.
- `lib.mkBridge { pkgs, ... }`: the same artifacts without module side effects.
  Direct imports of `nix/mk-bridge.nix` also work, with no flake inputs.
- `pkgs.callPackage ./nix/package.nix { src = bridgeSource; }`: source package.
  Pass `src` explicitly (some nixpkgs versions have an unrelated `pkgs.src`).

## Module configuration

```nix
{
  imports = [ inputs.paseo-bridge-pi.nixosModules.default ];
  programs.paseo-bridge-pi = {
    enable = true;
    paseoPackage = myNativePaseo;
    host = "127.0.0.1:6767";
    passwordFile = "/run/secrets/services/paseo/password";
    autoConnect = true;
    importSessions = true;
    generateTitles = true;
    debug = false;
    topology.enable = true;
    rootTrustMode = "unsafe"; # topology roots currently require this opt-in
    supervisedLauncher = "/run/current-system/sw/bin/pi";
    unsafeLauncher = "/run/current-system/sw/bin/pi-unsafe";
    startTimeoutMs = 120000; # 1000..600000
    rpcExecutable = "/run/current-system/sw/bin/pi-unsafe";
    permissionGateExtension = "${inputs.pi-agent-extensions}/permission-gate/index.ts";
    rpcExtensions = [
      "${inputs.pi-agent-extensions}/openai-accounts/index.ts"
      "${myClaudeBridge}/index.ts" # use the actual provider entry point
    ];
  };
}
```

`package` and `nodejs` are injectable. All launcher/extension options above are
required absolute strings; `rpcExtensions = []` is a deliberate explicit choice.
The constructor takes the same options except `enable`/`integration` and uses
`topology = true` instead of `topology.enable`. It requires `pkgs`.

`integration` (or the constructor result) exposes:

| Attribute | Meaning |
| --- | --- |
| `package` | Pi package artifact; add to your native Pi package list |
| `rpcPackage` | `bin/pi-paseo`: fixed environment and explicit RPC extensions |
| `shimPackage` | `bin/pi-paseo-shim`: provider, with fixed launcher trust |
| `environment` | Shared bridge/endpoint/defaults/topology environment; safe as input to wrapped Pi |
| `shimEnvironment` | Shared environment plus shim-only root trust, launcher paths and startup timeout |
| `extensionPath` | Explicit bridge `extension/index.ts` |
| `pluginPath` | Native Paseo plugin directory |
| `providerCommand` | List for native `agents.providers.pi.command` |
| `pluginSettings` | Fragment for native `plugins` |

Host-owned native integration, for example:

```nix
let bridge = config.programs.paseo-bridge-pi.integration; in {
  services.paseo.environment = bridge.environment // {
    PI_COMMAND = "${bridge.rpcPackage}/bin/pi-paseo";
    # Set HOME, XDG_RUNTIME_DIR and TMUX_TMPDIR consistently with login Pi.
  };
  services.paseo.settings = {
    pluginsEnabled = true;
    plugins = bridge.pluginSettings;
    agents.providers.pi.command = bridge.providerCommand;
  };
}
```

For a wrapped supervised Pi package, also pass `bridge.environment` to **both**
its normal and unsafe environment arguments, and `bridge.package` to its
additional package list. Alternatively add the artifact to native Pi settings
`packages`. The modules deliberately do not own or overwrite Pi `settings.json`.
Use the same bridge settings for HM and the daemon; session variables alone do
not configure a system daemon. These modules create no service.

`environment` deliberately contains no Pi launcher paths and accessing it does
not validate or force those paths. Store-backed Pi launchers may therefore refer
back to the wrapped package without a Nix recursion:

```nix
let
  piWithPaseo = pkgs.pi-supervised.override {
    environment = bridge.environment;
    unsafeEnvironment = bridge.environment;
    piAdditionalPackages = [ bridge.package ];
  };
  bridge = import "${inputs.paseo-bridge-pi}/nix/mk-bridge.nix" {
    inherit pkgs;
    paseoPackage = myNativePaseo;
    rootTrustMode = "unsafe";
    topology = true;
    supervisedLauncher = "${piWithPaseo}/bin/pi";
    unsafeLauncher = "${piWithPaseo}/bin/pi-unsafe";
    rpcExecutable = "${piWithPaseo}/bin/pi-unsafe";
    permissionGateExtension = myPermissionGateExtension;
    rpcExtensions = myExplicitProviderExtensions;
  };
in bridge
```

Do **not** pass `shimEnvironment` into `piWithPaseo`: it intentionally refers to
that package. The shim wrapper pins `shimEnvironment` before launch, while the
RPC wrapper pins only shared `environment`. Launcher/RPC-extension validation
is lazy on the corresponding wrapper outputs, not the constructor attrset.

## Boundaries and precedence

- `autoConnect` supplies `PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT`; the mutable
  `/paseo-bridge auto on|off` preference in Pi's native agent directory wins.
  No Nix-managed bridge-settings symlink is created. Pi's `getAgentDir()`
  determines that writable directory, including a custom `PI_CODING_AGENT_DIR`.
  The canonical file is `getAgentDir()/paseo-bridge/settings.json` (normally
  `~/.pi/agent/paseo-bridge/settings.json`). Only when it is absent is the legacy
  `~/.pi/paseo-bridge/settings.json` boolean `auto` read as a fallback. An existing
  canonical file supersedes legacy preferences completely. A missing/invalid
  boolean uses the operator default, then the built-in `true` default. No other
  state, credentials, or legacy file is copied or migrated.
- `importSessions` and `generateTitles` supply the corresponding
  `PI_PASEO_BRIDGE_IMPORT_SESSIONS` / `PI_PASEO_BRIDGE_GENERATE_TITLES` booleans;
  debug uses `PI_PASEO_BRIDGE_DEBUG`. These are operator settings, not a security
  sandbox. Wrappers pin the configured environment before executing children.
  These booleans accept `1/true/on` and `0/false/off` (case-insensitive); unset or
  unrecognized values use `true`. Legacy truthy `PI_PASEO_BRIDGE_NO_IMPORT` and
  `PI_PASEO_BRIDGE_NO_TITLE` override the new settings, preserving the old
  presence semantics even for a string value of `0`. Disabling import does not
  prevent adoption of an already assigned Paseo agent (fork/root handoff).
- RPC always disables extension discovery with `--no-extensions` (early RPC
  workaround) and explicitly loads permission-gate, bridge, then the supplied
  provider extensions. The caller must supply a real permission-gate extension
  and appropriate supervised/unsafe executables, not bypass wrappers. A provider
  extension omitted from this list is **not** recovered from Pi's settings.
- Fork launchers and root trust are declared, never inferred from ambient PATH.
  Supervised source forks stay supervised; unsafe source forks stay unsafe.
  Linux topology currently supports only an explicitly unsafe root. Setting
  `rootTrustMode = "supervised"` is supported with topology disabled.
- Native Paseo owns plugin loading/compilation (including its plugin SDK,
  React/React Native, TanStack Query and zod), auth, endpoint config and services.
  Pi supplies its extension SDK/pi-ai; Node >=22 runs the shim; tmux is a host
  dependency for topology. This source package performs no dependency download
  or client compilation. The upstream package declares MIT; Nix metadata retains
  that license, and this packaging adds no different license claim.
- The host owns service identity, runtime directories, tmux/systemd topology
  helpers, firewall, relay, account plugins, credentials, and secret permissions.
  `passwordFile` is a runtime path only, never secret contents or a store path.
  No daemon restart, firewall change, secret provisioning or native config
  replacement is performed by these modules. Existing native password env
  precedence remains unchanged; do not also supply stale `PASEO_PASSWORD`.
- Settings writes use a same-directory exclusive temporary file, fsync, and
  atomic rename. The auto command and native `install`/`uninstall` refuse
  symlinked, non-regular or read-only files and immutable/store directories,
  reporting explicit errors. They never write through a managed symlink.
  With native declarative config, merge these fragments there rather than using
  `/paseo-bridge install` or `uninstall` to modify the immutable native config.

## Operator-to-runtime coverage

| Option | Consumer / behavior |
| --- | --- |
| `autoConnect` | `isAutoEnabled()` at new TUI session start; mutable canonical/legacy boolean wins over `PI_PASEO_BRIDGE_DEFAULT_AUTO_CONNECT` |
| `importSessions` | `isImportEnabled()` gates CLI import/reconnect allocation in `registerWithPaseo`; assigned-agent adoption is preserved |
| `generateTitles` | `isTitleGenerationEnabled()` gates automatic title generation/sync in `maybeGenerateSessionTitle` |
| `debug` | Existing `PI_PASEO_BRIDGE_DEBUG` enables runtime logging |
| `paseoPackage` | Pins `PASEO_CLI` used by extension and shim CLI requests |
| `host` | `PASEO_HOST` selects native CLI import/inspect and connection endpoint |
| `passwordFile` | Existing `readPaseoPassword()` reads runtime secret, after native inline-env precedence |
| `topology.enable` | Existing `PASEO_TMUX_TOPOLOGY` selects native topology import and shim root handling |
| `rootTrustMode` | `PI_PASEO_ROOT_TUI_KIND`; constructor enforces explicit unsafe topology root |
| `supervisedLauncher` / `unsafeLauncher` | `PI_PASEO_TUI_BIN` / `PI_PASEO_UNSAFE_TUI_BIN` select trust-matched fork executable paths |
| `startTimeoutMs` | `PI_PASEO_FORK_START_TIMEOUT_MS` consumed by fork startup wait |
| `rpcExecutable` | Pinned RPC wrapper exec target (`PI_REAL_BIN` points at that wrapper) |
| `permissionGateExtension` / `rpcExtensions` | Explicit RPC `--extension` arguments; mandatory gate and bridge remain loaded with discovery disabled |

Validation of this refactor is limited to source review and Nix evaluation/
formatting. No runtime tests, typechecks, smoke scripts, deployments or restarts
were performed.
