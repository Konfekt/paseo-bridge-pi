# Harness workers belong to Work Agents, not native provider tabs

## Admission and fix

Paseo's `pi-subagents` adapter admits a native descriptor as soon as a `subagent`
tool call contains `agent` and `task`. It does not wait for a child session or a
terminal result. Bridge synthetic `::paseo-child::` calls therefore registered
native tabs during live execution and history replay. The separate private
`paseo_native_subagents` protocol also upserted descriptors and started native
transcript readers, including on reconnect.

The bridge no longer resolves or publishes native session links and no longer
enriches history with native session paths. Projected subagent arguments carry
`_paseoWorkAgent: true`; this is transport-only, not a model-visible argument or a
change to persisted transcripts. The coordinated Nix server adapter recognizes
that marker, legacy synthetic IDs, and harness result metadata. It emits only a
non-destructive hide for those IDs, leaving native tool-detail rendering to the
existing mapper. Legacy private snapshots are validated but can only hide rows;
they cannot create descriptors or start session readers. Other native Pi
integrations and other providers are not opted out.

The server's existing hide semantics preserve direct retained timeline access,
while excluding hidden descriptors from list/listAll and sending native removal
events for already-loaded clients. No transcript or independent chat is deleted.
Work read-only routing, identity checks, owner checks, permissions, accounting,
usage, background execution, and result/error projection remain unchanged.

## Rollout / checks

Deploy the bridge and coordinated `nix/packages/paseo` server changes together.
Reload/reattach bridge providers and hydrate their history so already-loaded
legacy descriptors are hidden too. A stale provider must not be accepted as
migration evidence merely because new launches are clean.

`test/subagent-paseo-consumer.test.ts` runs against the compiled production
adapter, extension host, RPC private routing, and descriptor store via
`PASEO_SUBAGENT_ADAPTER_MODULE`. It covers live calls, history, reconnect,
preloaded descriptors, retained transcripts, and unrelated native integrations.
The Nix checkPhase includes this test, but ordinary builds currently have
`doCheck = false`; run it explicitly against the installed output. Projection
tests retain error and outcome coverage. Deployment and live Work list/conversation checks are owned by
the coordinating agent; no deployment is performed by this change.
