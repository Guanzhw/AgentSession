---
status: implemented
date: 2026-09-17
decision: Keep recorded inherited background readable when its source session identity is absent
---

## Context

The DSH parser validates inherited-prefix boundaries independently of the
optional `parentSession` header. It already excludes that prefix from owned
messages and usage. The adapter and shared Reader nevertheless require a
source ID to expose the prefix, so valid recorded content can be unreachable.
The P8 acceptance record explicitly tracks this gap. Installed
`@deepseek-ai/dsh-session` 0.1.5-rc.1 declares `parentSession?` in
`lib/types/types.d.ts:71`; `lib/index.js:1079–1086` requires the seed and
inherited count independently of that optional identity. This supersedes the
source-ID requirement in the earlier [DSH disclosure decision](2026-09-17-dsh-inherited-context-reader.md).

## Decision

Make `InheritedContextView.sourceSession` nullable. A recorded prefix remains
readable, folded and paginated when the source identity is absent; the Reader
states that the source session was not recorded and supplies no invented link.
Known-source IDs and links retain their existing behavior. DSH owns boundary
classification; the shared Reader only renders the normalized projection.

All continuation markup belongs to its mounted Reader pane, including inherited
pages loaded after an inline child was opened. Reuse the existing DOM scoping
helper so copied message IDs cannot collide with another pane.

## Alternatives considered

Discarding a known prefix because its source is unknown loses retained history.
Treating the prefix as owned work changes accounting and chronology. Guessing
a parent from nearby records makes an unsupported relationship claim.

## Consequences

Owned messages, search, exports, usage and runtime facts remain unchanged.
Unknown identity differs from a recorded identity whose source file is missing:
the latter retains its canonical reference. No additional provider semantics
enter the browser and no source files are changed.

## Verification

`npm test`: 883/883; four focused files: 67/67, also on Node 22.15.0.
Independent review found no substantive issue. After restarting the production
server, the real DSH 39-message prefix, source-file hash and all five existing
session API fields were unchanged; seven providers' Reader/runtime checks pass.
`npm run qa:e2e` passes with no browser errors; `npm run review`,
`npm run pre-push` and `git diff --check` pass.

An isolated v3 fixture with 85 inherited messages was exercised in the browser:
40 → 80 → 85, failed-request retry, complete late long-field reading, inline
child namespace isolation, and retained pages after sibling switching.
Unknown-source background stays folded initially and has no invented link.
English/dark desktop and narrow checks, Chinese/light 390 px checks, and
keyboard activation pass. Scoped axe checks on the child pane and unknown-source
disclosure have zero violations. These are local checks, not full P11 acceptance.

Bounded inspection found no real over-40 or unknown-source sample. The real
39-message DSH browser regression therefore does not claim those boundaries;
they remain fixture-backed. See the [acceptance record](../../../docs/design/runtime-acceptance-evidence.md).
