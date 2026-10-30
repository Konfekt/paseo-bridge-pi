# Pi Stop cancellation handshake

The bridge acknowledges `abort` only after Pi becomes idle. Public `ctx.abort()` dispatches cancellation without exposing its completion promise; [abortAndWaitForIdle](../extension/abort-dispatch.ts) observes `isIdle()` instead of treating dispatch as success.

A provider response timeout does not establish that cancellation was refused. Tool cleanup may still be running. The default wait has no fixed deadline; its bridge-lifetime signal cancels observation on disconnect, session replacement, or shutdown. An explicit helper timeout reports failure to observe idle, not reversal of the cancellation request.

The lifetime signal is separate from the active turn's signal. Check it before each idle observation so an invalidated waiter cannot acknowledge a replacement session. Polling waits leave no persistent event subscription.

`clear_queue` remains unsupported by the attached extension. Returning Pi's native unsupported-command error lets Paseo proceed to its existing abort path; it does not prove queued messages were cleared. Permission enforcement and process ownership remain unchanged.

The [owning tests](../test/abort-dispatch.test.ts) cover settlement, invalidated lifetimes, and explicit deadlines. The [reference](../docs/reference.md) describes user-visible Stop and session behavior.
