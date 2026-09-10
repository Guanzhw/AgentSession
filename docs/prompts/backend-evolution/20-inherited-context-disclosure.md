# Spec 20: bounded inherited-context disclosure

## Problem

Some Codex child rollouts contain an explicitly marked copied parent prefix.
The owned transcript correctly removes that prefix, but the recorded text is
otherwise unreachable from the session page. This hides useful background and
can make a child request look context-free.

## Contract

`ProviderAdapter` may expose `getInheritedContext(sessionId)`. The optional,
provider-neutral projection returns a bounded list of normalized `Message`
records, the recorded total, whether the bound truncated the list, and the
canonical source-session reference. It returns no projection when the session
has no recorded parent reference or no boundary-marked messages.

Codex derives this projection only from its record-level
`inherited-parent-context` classification. Developer/system records are shown
as normalized `system` messages with their recorded source role; untagged
response-item user rows in that proven copied prefix are likewise disclosed as
recorded system background, never as owned requests. No parent text is guessed
and no provider-owned file is changed. The projection does not
enter `getMessages()`, token stats, index/search, export, ToC, or Session
Protocol runtime projections. The existing owned parser path remains the
default selection.

## UI

The session conversation page renders the projection in a separate,
default-collapsed “Recorded inherited context” disclosure. It reuses the
normalized message/part renderer, keeps collision-free message and part
anchors, and remains discoverable by the existing transcript search/hash
reveal behavior. The note identifies the content as background, excludes it
from request/token totals, shows the explicit bound, and links to the
canonical parent session when available. Long text uses the existing
progressive-content endpoint; continuation carries an explicit
`inherited-context` scope and resolves its prefixed parts through the same
optional accessor without adding provider-specific routing.

## Acceptance

- Owned Codex messages, token accounting, search/index/export, ToC, and runtime
  projections remain unchanged.
- Boundary-marked inherited user and developer/system messages render through
  the real parser-to-page path; assistant/tool records are exposed if the
  source records them, without claiming missing context is complete.
- The projection is bounded at 40 messages, reports total/truncated truthfully,
  and does not duplicate token statistics or create a child request.
- EN/ZH labels, long-content continuation, canonical parent link, independent
  anchors, and the default-collapsed/searchable disclosure have regression
  coverage.
