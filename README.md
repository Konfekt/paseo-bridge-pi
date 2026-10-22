# paseo-bridge-pi

Use the same live Pi conversation from a terminal and [Paseo](https://paseo.sh).
The terminal stays usable; Paseo can stream the conversation, send messages and
use native model/thinking controls. An optional plugin adds Pi work and account
controls without replacing native conversations.

## Choose the components

| Component | Purpose | Installed by |
| --- | --- | --- |
| Pi extension | Attach the live terminal session, synchronize state and expose session-owned controls | Pi package or Nix module |
| Provider shim | Connect Paseo's Pi provider to that session; preserve fork/launcher trust | Nix constructor or explicit native provider registration |
| [Paseo plugin](plugin/README.md) | Work, Goals, jobs, agents and account surfaces | Native Paseo plugin loader, on the daemon host |
| Optional Paseo patches | Provider/server capabilities not available through public plugin APIs | Your Paseo package, separately from this bridge |

Basic attachment uses native Paseo APIs. Advanced integration depends on the
matching Pi extensions and, for some capabilities, Paseo server patches. An
installed desktop/mobile client is a separate delivery boundary: a server
switch does not update its built-in renderers or popover limits.

## Start with Nix

The repository exports reusable packages, Home Manager/NixOS modules and a pure
constructor. Your host selects endpoints, launchers and policy; the package owns
the RPC/shim wrappers and their environment.

```nix
inputs.paseo-bridge-pi = {
  url = "github:taugoust/paseo-bridge-pi";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

Import `inputs.paseo-bridge-pi.nixosModules.default` or
`homeManagerModules.default`, then configure `programs.paseo-bridge-pi`.
Launchers and the permission-gate extension are explicit required integration
inputs, not guesses from ambient `PATH`.

→ [Complete Nix API and composition examples](nix/README.md)

A source input with `flake = false` is also supported: import
`nix/mk-bridge.nix` with your existing `pkgs`, or import the module directly.
No extra package-set lock graph is required for that consumption path.

The module does **not** create a Paseo service, configure a firewall, provision
secrets or replace native Pi configuration. Merge its `integration` outputs into
your existing native Paseo configuration and Pi package composition.

## Install without Nix

```sh
pi install git:github.com/taugoust/paseo-bridge-pi
```

Then `/paseo-bridge install` registers the shim in a **writable** native Paseo
configuration. Restart the daemon after changing its provider registration.
For declaratively managed Paseo configuration, use the Nix integration instead;
do not run install/uninstall commands against an immutable generated file.

The optional plugin is installed independently through Paseo:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The plugin requires Paseo **0.11.4 or newer**; matching server capabilities and
updated `pi-agent-extensions` are required for their corresponding controls.
Node 22+ runs the shim, Pi 1.x supplies its extension SDK, and the native Paseo host
supplies the plugin SDK and UI dependencies. Linux tmux topology additionally
requires tmux and explicit trust-matched launchers.

## Everyday controls

| Command | Purpose |
| --- | --- |
| `/paseo-bridge status` | Inspect connection and installation state |
| `/paseo-bridge connect` / `disconnect` | Attach or detach this session |
| `/paseo-bridge auto on` / `off` | Change the mutable auto-connect preference |
| `/remote-reload` | Reload Pi resources while idle, including from Paseo |

Pi's `/reload` remains terminal-only. Resource reloads do not update the Pi
executable or Paseo daemon, and existing worker processes retain their code.
Neither command should be used to silently interrupt active work.

→ [Commands, configuration, reload behavior and protocol reference](docs/reference.md)

## Configuration ownership

Nix controls supported defaults and integration choices: automatic attachment,
import, titles, debugging, endpoints, launcher selection and startup bounds.
Runtime preferences remain separate from immutable configuration. The Nix API
reference describes precedence, legacy environment compatibility and required
reloads; Pi's canonical agent directory determines preference locations.

Passwords are runtime **file references**, never literal Nix values. Private
operator capabilities, assigned sockets, epochs and session/worker identities
are runtime authority—not user preferences or options. Credentials remain in
their canonical provider stores and are never sent to plugin client state.

## Architecture and safety

- A terminal session retains ownership of its Pi runtime; the shim transports
  native RPC instead of injecting terminal keystrokes.
- The daemon owns native project/workspace placement and provider lifecycle.
- Supervised forks stay supervised; unsafe forks require their matching explicit
  launcher. UI prompt mode is not a substitute for runtime authorization.
- Stop acknowledgement and actual run settlement are distinct. Pending cleanup
  must not fabricate idle state or cancel independent background jobs.
- The [plugin security reference](plugin/README.md) explains private sockets,
  exact identity checks and the limits of same-user isolation.

## Repository map

`extension/` contains the Pi integration, `shim/` the provider transport,
`plugin/` the optional native Paseo plugin, and `nix/` reusable packaging/modules.
`docs/` holds detailed reference material; `issues/` tracks implementation and
rollout notes separately from the installation guide.

## License and attribution

MIT; see `package.json`. Existing upstream credits and third-party notices are
retained. Adapted native Paseo UI code carries its Apache-2.0 notices in the
plugin sources.
