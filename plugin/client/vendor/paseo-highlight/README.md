# Exact native Paseo syntax highlighting

Generated from Paseo **0.12.0**, upstream `cafe4b01c8522ff39560241c5deb01427dc8dc5b`:

- `packages/highlight` (native CodeMirror/Lezer grammars and token roles)
- `packages/app/src/utils/highlight-cache.ts` (unaltered cache/size guard)
- `packages/app/src/utils/diff-highlight.ts` (unaltered old/new document reconstruction)

Only module import resolution is adapted at bundling time. There is no bridge tokenizer, grammar, or change to the Paseo client. `provenance.json` records every input hash, dependency version and bundle hash. `licenses/` retains Apache-2.0, the Astro MIT notice, and all 25 dependency licenses (including dependencies parsed then tree-shaken).

Reproduce using `plugin/vendor/paseo-highlight/build.mjs <immutable Paseo /lib/paseo> <pinned upstream source> <matching Nix npm-deps cache>`. The cache supplies original package license texts stripped from the installed runtime closure; it installs nothing.

The public plugin UI exports no native code renderer. The bridge adapts the native token rendering to public React Native Text, uses the native `data-pmono` surface marker, and selects grammar only from actual Read/Write/Edit file arguments. Shell/unknown output stays plain, as the native shell detail does.

`toPluginTheme` exposes base colors but **not** `theme.colors.syntax` or the user's syntax-brand preference. Therefore the adapter uses upstream GitHub light/dark defaults on the public surface colors, or an exposed syntax palette if a future SDK supplies one. Custom native syntax-brand synchronization requires a supported public API extension; it cannot truthfully be claimed with this SDK. Native default-theme browser parity is testable without changing user settings.
