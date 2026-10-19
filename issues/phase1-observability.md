# Phase-one Pi observability in Paseo

## Status
Implemented and automated validation passed. Deployment and native iOS verification remain pending.

## Scope
Read-only Activity panel with Progress, Response stamps, and Cache diagnostics. Reuses the authenticated harness socket with a feature-specific snapshot RPC. Requests bind agent/workspace/session/runtime identity; the backend validates snapshot schemas and rechecks identity after asynchronous work. No model prompts or controls are sent.

## Acceptance
- Validate all three views with the Paseo 0.11.4 host compiler and frontend export boundaries.
- Verify loading/unavailable/error handling, session and host isolation, cleanup, and stale-response rejection.
- Verify real private transport schema/identity checks and no secret or prompt leakage.
- Run bridge regression tests and typecheck.
- After a separately authorized deployment, verify native iOS pill, panel, tabs, scrolling, refresh/reconnect, and settings workflow. Automated rendering tests do not satisfy this device check.

## Automated results

133 bridge tests passed (9 optional skipped), bridge TypeScript passed, and 23 plugin tests passed (1 optional real-worker test skipped) using the installed Paseo 0.11.4 compiler and runtime dependencies. Compiled Activity tests cover all three views, errors, host/session binding and cleanup. Compiled server tests exercise the real private socket, schema stripping, invalid snapshots, and session mismatches. These results do not replace device verification.

## Deliberate UI scope
Stamps appear as per-response metadata records in a separate panel, not original-bubble decorations. Progress is structured saved state, not terminal-widget parsing; completed steps remain reviewable. Cache estimates are retrospective session metrics, not account quotas. Settings remain owned by Pi commands/files; the initial Activity panel is read-only.
