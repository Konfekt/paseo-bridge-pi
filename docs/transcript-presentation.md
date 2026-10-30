# Work tool presentation

Work background history, live events and foreground activity use one plugin-owned tool badge. The client compiles with the published Paseo 0.13.0 compiler and imports only public host modules. No native server mapper, protocol display module or highlighting package is bundled.

## Display

The collapsed badge shows the exact tool name and exposes its lifecycle status to accessibility controls. Expanding it shows selectable, scrollable **Arguments** and **Output** text. Failed results use **Error** and the danger color. No tool-specific label, generated summary, syntax color, line gutter or reconstructed diff is inferred.

Known-tool arguments use the existing allowlist. Invalid or oversized known-tool arguments show an unavailable marker instead of exposing unprojected fields. Unknown tools retain bounded opaque input. Output text is reserved first within the 24 KiB detail budget, so oversized arguments cannot hide a failure reason.

Recognized transport envelopes are unwrapped. Literal JSON in text blocks remains literal text; image and audio payloads become placeholders. The text formatter retains depth, node and byte limits. It does not infer success, task identity or navigation from prose.

## Transport and ownership

The existing optional `toolPresentation` and `toolArguments` wire fields remain validated, name-bound and bounded. A matching validated result can restore text lost by clipping. It is rendered as text, not passed through a fork-specific native mapper. Text and metadata always come from the same live or retained result; a newer live result cannot inherit stale metadata.

Foreground call/result correlation still requires exact call identity. Background navigation retains the existing session/runtime, task/child/group and attempt checks. Presentation data grants no control or navigation authority. Markdown, media placeholders and pending interactive controls are unchanged.

## Verification

Set `PASEO_PLUGIN_COMPILER` to the installed stock `@getpaseo/server/dist/server/server/plugins/compiler.js`, then run:

```sh
npm run test:plugin
```

The gate compiles both production bundles from a temporary source copy without checkout dependencies. Compiled tests cover Work-tab interactions, result provenance, literal text, media redaction, failure output and the detail budget. These checks do not claim native-device visual parity or exercise optional companion runtimes unless their explicit test settings are supplied.
