# Pi Stop cancellation handshake

Paseo calls a provider's interrupt and treats it as refused when no answer arrives within two seconds. It then waits two more seconds for the turn to end and otherwise fails Stop or the replacing message with "active run cancellation was not acknowledged".

Public `ctx.abort()` dispatches cancellation without exposing its completion promise, and Pi becomes idle only after the running tool returns. [abortAndAcknowledge](../extension/abort-dispatch.ts) dispatches the abort, waits up to 1.5 seconds for `isIdle()`, and then answers either way. When Pi is not idle yet, it hands back a promise that settles once Pi is idle.

Until that turn ends with `agent_settled`, or one second after Pi is idle if that event is missing, the bridge keeps feeding the turn-visibility projection but forwards none of the stopped turn's events: Paseo has already ended the turn, and its late `agent_end` would end the next one. A Paseo prompt that arrives meanwhile waits for the stopped turn, so it starts a new turn instead of queueing as a follow-up, and fails after 20 seconds, inside Paseo's 30-second prompt deadline.

The bridge-lifetime signal is separate from the active turn's signal. It is checked before each idle observation, so an invalidated waiter never reports a successor session's state. The idle watch polls with unreferenced timers and leaves no event subscription.

`clear_queue` remains unsupported by the attached extension. Returning Pi's native unsupported-command error lets Paseo proceed to its existing abort path; it does not prove queued messages were cleared.

The [unit tests](../test/abort-dispatch.test.ts) cover the acknowledgement deadline, settlement and invalidated lifetimes. The stock-daemon test in [session-workspaces.integration.ts](../test/session-workspaces.integration.ts) replaces and stops a turn whose tool ignores cancellation.
