# Pi Stop cancellation handshake

## Evidence

For agent357becb8, the supplied log records a cancel request at 1792674778905,
manager interrupt timeout at 1792674780953 (+2048ms), refusal/warning at
1792674783102 (+4197ms), then a later actual `turn_canceled`.
These timestamps establish late settlement, not cancellation refusal. They do
not establish which active tool/provider cleanup caused the delay.

The bridge previously dispatched fire-and-forget `ctx.abort()` and rejected if
`ctx.isIdle()` remained false for 1500ms. Native Pi's RPC Commands reference
requires `abort` to wait for idle before responding. SDK and extension docs
identify `agent_settled`, not `agent_end`, as the final lifecycle boundary.

## Bridge change

- Preserve native idle-gated acknowledgement; do not redefine success as request
  acceptance or force idle.
- Remove the default 1500ms failure. Explicit helper caller timeouts remain
  available and retain their existing failure behavior.
- Reject absent contexts and closed lifecycle signals before dispatch/idle ACK.
- Capture the supplied context and bridge lifecycle signal at dispatch. Reuse
  the existing preflight lifetime controller, invalidated on detach, server
  stop, session replacement/start, shutdown/reload and runtime reaping. Check
  invalidation before every idle observation; the default 25ms polling interval
  also bounds waiter cleanup after invalidation. No event subscriptions or
  timers outlive the waiter except its current polling sleep.
- Do not use `ctx.signal`, which is turn-owned and is expected to abort during
  the operation being observed. Native session lifecycle events, documented in
  the extension API, provide the lifetime invalidation boundary instead.
- Stop separately aborts and renews pending prompt-admission checks before it
  aborts Pi. An admitted prompt waiting in idle preflight receives the existing
  aborted-prompt response instead of starting after Stop was acknowledged.
  A final synchronous dispatch guard closes the preflight-resolution race.
  The abort waiter still uses the separate bridge-lifetime signal, not the
  renewed prompt-admission signal.
- No job cancellation, process signals, reloads, or runtime restarts are added.

## Required server coordination

The manager's interrupt deadline must mean pending/unknown, not refusal. Retain
per-run identity and observe authoritative settlement without synthesizing idle
from dispatch acceptance. Gate destructive actions on true settlement. A future
accepted-request ACK would require an explicit protocol/capability distinction;
plain native abort success remains idle-gated.

The bridge currently returns unsupported for `clear_queue`. Native Pi docs warn
that abort continues queued messages if the queue remains populated. Server
fallback from unsupported clear_queue is not proof that the queue was cleared;
there is no supported public queue-clearing extension API used here.

## Verification scope

Source review only, per instruction: no tests, typechecks, smoke scripts,
reloads, deployments, or restarts. Parent must review and integrate the
coordinated server change before deployment. An explicit timeout or lifecycle
invalidation is not proof the already-dispatched cancellation was refused.
