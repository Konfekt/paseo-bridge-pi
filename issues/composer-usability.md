# Composer control consolidation

## Status

The previous composer batch was approved and published: bridge `4288873`, core `9dcf9c5`, Nix pins `3d8b8df`. Subsequent Work layout changes are deployed locally for review and remain uncommitted. Do not publish those without approval. Latest Matebook system: `/nix/store/i8i5r5rg7yia7clgqk5k6bw4msdcp3nq-nixos-system-matebook-26.05.20260916.4c78701`. Idle Briefcase icon and Create/copy cleanup deployed successfully; job `job-bb24841c3963ed177db94f5d` output read and job reaped. No tests; normal Nix checks/smoke restored. Device appearance remains for user review.

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

## Work refinement (current review batch)

Current sizing/alignment refinement (production switch succeeded; job `job-6b41a9003949d8e00023cd13` output read and reaped; normal checks/smoke restored): one WorkOverview owner derives the preferred desktop width from the selected tab and completed/active counts. Populated completed Jobs request 960px, completed Agents 1120px, active lists 880px. Empty views and Goals/Worktrees keep default sizing; mobile/compact views do not request desktop widths. The host clamps to the viewport and accepts presentation-only updates without closing the surface. Host validation permits 280–1280px.

Stock-client-compatible resolution: idle Work renders the standard Lucide Briefcase icon; active work renders the existing status ring in the same slot. Work no longer sets or relies on `iconVisible`. This fills the stock client's reserved icon space and keeps the status observer mounted without a patched Mac app. The user explicitly chose an idle icon instead of hiding the slot. All four tab labels use identical minimum height, centered alignment and line height. Completed jobs/agents use rounded, bordered cards with untruncated titles. Selected background-job output expands inside its own card as a selectable monospace block without an Output heading. Foreground job buttons/unavailable rows also have rounded cards.

Correction: the user's installed Mac Electron client has its own host bundle. Refreshing it does not load server-bundled host changes. The idle icon now resolves the empty-slot issue using the stock client; the desktop width preference still requires host support or a different stock-client-compatible approach. Do not claim the Matebook switch updates the installed Mac app. The latest bridge plugin changes remove Completed controls while already in completed views and remove foreground/background headings there, with uniform card spacing. Empty Goals now offers paused creation; its capability flag disables unsupported old runtimes without additional helper copy, per the user's request. The button is labeled `Create`; paused semantics and the old-runtime capability guard remain unchanged. These plugin/service changes were included in `/nix/store/nmji5zifwb0bjm2wxyrrdkhm2b782lap-nixos-system-matebook-26.05.20260916.4c78701`. Paused creation persists the paused state synchronously, does not dispatch a model turn, and clears the draft only when the goal/session identity changes. No tests or extra validation scripts run. Visual confirmation remains for the user. Repository-container discovery from the previous update was confirmed working by the user after a full Pi restart.

- Preserve the native n/m checklist; it only appears when a checklist is active.
- Work groups Jobs, Agents, Worktrees, and Goals; the earlier separate Goal pill is removed.
- Badge priority: active native subagents, then foreground/background jobs, otherwise plain Work. Completed records do not count. Foreground helpers are tagged separately to avoid counting them again as subagents.
- Yellow/amber attention comes from actual pending interactions and idle decisions, not summary-text guesses. Active Pi sessions need `/remote-reload` after the turn to load the new core metadata.
- Jobs stacks Foreground and Background, with a compact `No active jobs` row when empty and a native outlined Completed toggle for retained/non-active records. No inner category tabs, Close/Refresh controls, Active jobs/agents return buttons, background-panel shortcut, background snapshot timestamps, or redundant running/completed status labels. Failed/cancelled outcomes remain visible. New shell jobs should have short human names (e.g. Deploy).
- Agents likewise defaults to a brief active list, with an empty-state row and Completed toggle. Completed agent rows now open a normal native dormant conversation that starts an independent copied session on its first prompt; see `independent-conversations.md`. The prior read-only workspace-tab viewer has been replaced. The new bounded, paginated conversation endpoint checks parent/session/runtime/child/attempt identity, reads only the owned private session file, skips thinking/private non-message entries, reports clipping, and never launches/resumes a worker. The active Pi process needs `/remote-reload` after the turn to load this new endpoint. The retained read-only conversation endpoint remains available internally; the primary UI now opens an independent native agent instead.
- The generic circular spinner was replaced with an Apache-2.0-attributed adaptation of Paseo's StatusRing: solid 6px dot, 12px ring, 1.5px stroke/gap, rotating quarter, 900ms cycle, and native light/dark blue/amber palettes. Web shares the document timeline; native uses React Native Animated because the private Reanimated clock is not exported to plugins. Reduced motion is respected. This is not the unrelated six-dot chat loader.
- Production client/server bundles compiled and Nix deployment succeeded. No test suites or host-parity suite were run under the user's no-tests instruction. Actual device appearance remains user-reviewed.

## Agreed scope

- Keep security control and existing policy; show Dangerous ask (prompts on) / Full access (prompts off), preserving the current mode. Prefer the existing native mode selector beside thinking. Keep a fail-closed plugin fallback when native modes are unavailable.
- Merge Jobs, Pi subagents and Foreground into one Tasks destination, preserving their existing actions and ownership/lifecycle protections.
- Activity uses a pulse icon. Keep BTW, Workflows and Accounts.
- The installed client plugin API has composer pills and workspace header buttons, but no composer-bottom toolbar contribution. The user approved retaining Activity and Tasks in the existing pill row rather than requiring a client rebuild.
- Transcript housekeeping and sidebar cleanup are deferred. Files/Changes already work and remain unchanged.

## Header findings

The current workspace directory is `/home/taugoust/Workspace`, not a Git checkout. Paseo's repository actions are derived from that root's Git status; browsing repositories below it does not give the root a single commit target. The Run button is conditional on configured workspace scripts, and this directory has no `paseo.json`. Do not invent commands, change the session cwd, or select one of its repositories implicitly just to expose buttons. Accounts stays in the header.
