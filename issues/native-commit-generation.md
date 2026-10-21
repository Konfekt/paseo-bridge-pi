# Native Commit generation must stay headless and use the focused model

## Incident and approved behavior

The user clicked Paseo's native Commit button in a shared-checkout subagent conversation. Paseo generated a commit message and committed the pending bridge review batch as `bbd9d57`. The native action defaults to staging all checkout changes. Per explicit user approval, the commit was soft-reset to its parent, preserving all files/staging, and only the two metadata helper sessions (`0`/`1`, socket `/run/user/1000/tmux-1000/claude-bridge-full-trial`) were closed.

Read-only incident evidence: first helper failed on unsupported `openai/gpt-5.4-mini`; second helper used `openai/gpt-6-luna` and printed the exact JSON commit message. Both Pi TUIs remained open. No commit was pushed by the Commit handler; local branch returned to its tracking commit after the soft reset.

The user explicitly rejected new forms/confirmation UX. Keep the native button and use the focused subagent's model, without visible tmux helpers.

## Implementation

- `shim/pi-paseo-shim.js`: recognize Paseo internal helpers' `--no-session` before runtime discovery, attachment, or tmux topology routing. Launch the real Pi RPC command directly, retaining model/thinking arguments. Forward RPC stdio; EOF/signals stop the owned child, with bounded SIGKILL fallback. No fork promotion, session attachment, or topology relay on this route.
- `nix-config/packages/paseo/pi-focused-commit-model.patch`: existing per-client focused-agent tracking already validates the checkout cwd. Capture its provider/model/thinking synchronously at `generateCommitMessage` entry, before awaiting diff construction. For a focused Commit, this is the sole generation candidate. Missing model or generation failure is surfaced, not silently replaced with a different model or generic commit message. Unfocused Commit keeps native default-provider behavior but does not re-read focus after awaiting the diff. PR generation is unchanged.
- No changes to native Commit UI, staging behavior, or publishing behavior. Generation does not prompt/resume the original worker conversation.
- Scope limitation: this preserves existing metadata RPC authentication behavior. It does not implement inheritance of a named OAuth account selected only inside a persistent Pi runtime; do not claim that behavior.

## Review

Source reviewed, including helper lifetime, selection capture timing, type import and private cwd matching. No tests/smokes/typecheck suites or live Commit exercise: the user forbids them, and clicking Commit would mutate the review checkout. Production build/switch succeeded: `/nix/store/nmji5zifwb0bjm2wxyrrdkhm2b782lap-nixos-system-matebook-26.05.20260916.4c78701`. Deployment job `job-c55f1991f45dfcf305df29b2` output read and job reaped. Normal Nix checks and installed smoke invocation restored afterward. No live Commit was exercised; user review remains. No Pi process restart or Mac client update is required for this server/shim fix. Changes remain unpublished.

## Separate pending UI work

The user is using installed Mac Electron (`paseo://app`), not the server-hosted web frontend. Server-bundled host UI patches do not update that installed client. Previously claiming a client refresh alone would load new host popover-width/icon-slot support was incorrect. Bridge plugin UI changes can arrive dynamically, but host-level pill/width changes need delivery to the installed desktop client. Do not deploy/change the Mac host without authorization. Paused-goal creation is a separate Pi workflow service update and needs the running Pi process to load new code.
