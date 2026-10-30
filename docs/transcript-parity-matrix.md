# Work tool presentation contract

Work deliberately uses a smaller renderer than Paseo's native conversation view. It does not claim native tool-presentation parity. The former fork-only parser, mapper and syntax-highlighting imports have been removed.

| Surface | Work behavior |
| --- | --- |
| Tool identity and status | Exact producer tool name; authoritative lifecycle status; collapsed by default. |
| Arguments | Bounded JSON or opaque text; known-tool allowlists apply. Invalid known inputs are unavailable. |
| Results | Bounded selectable text; recognized transport wrappers removed; literal text preserved. |
| Failure | Result text retained before arguments consume the shared budget; danger-colored Error section. |
| Read, Write and Edit | Plain arguments/results, without syntax colors, line gutters or reconstructed diffs. |
| Structured jobs, agents and goals | Safe typed result text when available, without native-generated labels or summaries. |
| Media | Image/audio placeholders; no binary payload in tool details. |
| Live/history correlation | Exact call identity and existing result-source precedence. |
| Controls and navigation | Existing worker/session/runtime ownership checks; never derived from presentation text. |

`npm run test:plugin` uses the selected stock Paseo compiler. The compiled Work-tab test covers collapsed/expanded details and live/history replacement; the compiled tool-details test covers safe bounded output. No native application build, fork compiler or Nix environment is required.
