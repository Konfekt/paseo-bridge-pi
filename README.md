# 🔗 Pi ↔ Paseo

[![Pi](https://img.shields.io/badge/Pi-1.x-blue)](https://pi.dev) [![Paseo](https://img.shields.io/badge/Paseo-0.13.0%2B-purple)](https://paseo.sh) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](package.json)

**One live conversation. Terminal and Paseo.**

Keep working in Pi while Paseo streams the conversation, sends messages and controls the model.
Add the optional plugin for Goals, jobs, agents and accounts.

[Plugin guide](plugin/README.md) · [Full reference](docs/reference.md)

## 📦 Choose the components

| Component | Use it for |
| --- | --- |
| [Pi extension](extension) | Attach the live terminal conversation to Paseo. |
| [Provider shim](shim) | Route native Paseo RPC to the owning Pi session. |
| [Paseo plugin](plugin/README.md) | Add Work, Goals, jobs, agents and account controls. |
| [Optional Nix integration](nix/README.md) | Declarative packaging and configuration. |

## 🚀 Install with Pi and Paseo

Requires Pi 1.x, Node 22+, and Paseo 0.13.0+. No Nix installation, patched Paseo build, or separate plugin compiler is required.

Install the Pi extension:

```sh
pi install git:github.com/taugoust/paseo-bridge-pi
```

Inside Pi, run `/paseo-bridge install` to register the provider shim in writable Paseo configuration. Restart the Paseo daemon after active work finishes:

```sh
paseo restart
```

Install the optional Work and account-controls plugin separately:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The plugin compiles with stock Paseo and adds no runtime dependencies. Tool details use selectable plain text, without syntax highlighting or native tool-specific formatting. Optional controls still require their matching Pi extensions; server-specific integrations are listed in the [plugin guide](plugin/README.md). The root Paseo `pluginsEnabled` setting must be enabled to run installed plugins.

[Nix modules](nix/README.md) remain available for declaratively managed installations.

## 🎛️ Everyday controls

| Command | Action |
| --- | --- |
| `/paseo-bridge status` | Inspect the connection. |
| `/paseo-bridge connect` / `disconnect` | Attach or detach this session. |
| `/paseo-bridge auto on` / `off` | Set the auto-connect preference. |
| `/remote-reload` | Reload Pi resources while idle, including from Paseo. |

## 📚 Go further

| Topic | Guide |
| --- | --- |
| Packages, modules and the pure Nix constructor | [Nix API](nix/README.md) |
| Commands, environment and reload behavior | [Reference](docs/reference.md) |
| Permissions, private sockets and account controls | [Plugin guide](plugin/README.md) |
| Companion tools and workflows | [pi-agent-extensions](https://github.com/taugoust/pi-agent-extensions) |

> [!IMPORTANT]
> A server update does not update built-in desktop/mobile UI. Supervised forks stay supervised; credentials and control capabilities remain private runtime state.

## 📄 License

MIT; see [package metadata](package.json). Adapted Paseo UI sources retain their Apache-2.0 notices.
