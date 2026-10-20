# Composer control consolidation

## Status

Deployed locally for user review. Do not commit or push without explicit approval. Latest Matebook system: `/nix/store/063xj22iwzswk3mpqyfbfmqw9s5zbi6q-nixos-system-matebook-26.05.20260916.4c78701`.

Native feature controls were subsequently added for the existing Fast mode and write/edit review gate. They share the existing `/fast` and `/slow-mode` state; no new defaults are enabled. Fast mode appears only for models in the existing package's supported target list (the current gpt-6-astra selection is not in that list). Active sessions require `/remote-reload` after the current turn finishes. No test suites were run for these feature additions, as explicitly requested; package checks were skipped for this local build and their normal settings restored in the working tree afterward. Service health and presence of the deployed control services were inspected.

User-feedback corrections deployed:

- Activity's label is restored: the client rejects an empty label, so the attempted icon-only contribution was not visible.
- Review edits is a native labeled select showing `Review: On` or `Review: Off`, rather than an icon-only toggle with no useful state indication. The active bridge needs `/remote-reload` for its updated feature descriptor.
- The lowercase `btw` pill opens a desktop chat popover, not a workspace panel. It has no custom header or New/Close controls; uses copy/send/stop icons; places send/stop inside the input; supports desktop Enter/Shift+Enter; and uses a muted placeholder. Dismissal discards the local chat and requests cancellation/removal of the owned server thread, after any pending request settles. Cleanup failures are logged, not silently claimed successful.
- BTW automatically rebinds to changed sessions with a fresh chat and no message replay. Generation checks reject stale async completions. Each popup has an isolated query key with immediate cache collection on close.
- Following an iOS visibility report, mobile/compact layouts now use the SDK's expanded adaptive modal sheet instead of the menu popover. Its host owns keyboard dismissal/avoidance and safe-area clearance; the chat fills the available body. Modal state survives the pill action's temporary icon/spinner remount. Actual iOS device appearance is not verified.
- The candidate terminal `/btw` UI was inspected but is **not yet integrated**. The terminal command still has its placeholder behavior; do not report it restored.
- Tasks hover text is simply `Tasks`; category counts stay inside its popover.

No test suites were run for these feedback corrections. Deployment succeeded, Paseo is active, and its plugin loader reported loaded plugins. Actual client appearance remains for user review.

## Agreed scope

- Keep security control and existing policy; show Dangerous ask (prompts on) / Full access (prompts off), preserving the current mode. Prefer the existing native mode selector beside thinking. Keep a fail-closed plugin fallback when native modes are unavailable.
- Merge Jobs, Pi subagents and Foreground into one Tasks destination, preserving their existing actions and ownership/lifecycle protections.
- Activity uses a pulse icon. Keep BTW, Workflows and Accounts.
- The installed client plugin API has composer pills and workspace header buttons, but no composer-bottom toolbar contribution. The user approved retaining Activity and Tasks in the existing pill row rather than requiring a client rebuild.
- Transcript housekeeping and sidebar cleanup are deferred. Files/Changes already work and remain unchanged.

## Header findings

The current workspace directory is `/home/taugoust/Workspace`, not a Git checkout. Paseo's repository actions are derived from that root's Git status; browsing repositories below it does not give the root a single commit target. The Run button is conditional on configured workspace scripts, and this directory has no `paseo.json`. Do not invent commands, change the session cwd, or select one of its repositories implicitly just to expose buttons. Accounts stays in the header.
