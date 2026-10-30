# Headless Paseo metadata helpers

Paseo marks internal metadata generation with `--no-session`. The [provider shim](../shim/pi-paseo-shim.js) handles that flag before terminal attachment or runtime-owner discovery and forwards the original arguments to ordinary Pi RPC.

The helper must not attach to an existing conversation or open another terminal. Its model and thinking arguments remain unchanged. Closing the provider's input or receiving a termination signal stops only the helper's owned Pi child, with a bounded forced-termination deadline.

This boundary does not change Paseo's Commit button, staging, publishing, or model-selection policy. The bridge does not inherit account choices held only inside another Pi process. Native Commit still has its normal repository effects; helper isolation is not approval to run it.
