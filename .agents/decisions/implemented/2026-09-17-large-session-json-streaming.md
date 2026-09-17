---
status: implemented
date: 2026-09-17
decision: Stream complete session JSON without a whole-response string
---

## Context

The real 432 MB Codex root with more than 100 child tasks fails at
`JSON.stringify` in the complete session API (`Invalid string length`). The
response contains the existing session, tree, container, metrics and messages
projections. `json()` has already written status 200, so the route's error
handler then fails with `ERR_HTTP_HEADERS_SENT` and closes the connection.
The server remains online. The same five-field JSON export builds one pretty
string. This is a transport construction limit, separate from Reader loading.

## Decision

Use a shared, bounded structural JSON writer for those two complete responses.
Preserve fields, content, ordering and the export's two-space indentation.
Write arrays, objects and long strings incrementally; respect backpressure and
stop when the client disconnects. Once output starts, a serialization failure
must terminate that stream rather than append an error object. Keep ordinary
small `json()` responses synchronous, serializing before committing headers.

## Alternatives considered

Increasing the heap does not remove V8's maximum string length. Omitting tree,
container or content changes the existing response contract. Stringifying each
top-level field still leaves an unbounded family field. A new export format is
unnecessary for this observed consumer.

## Consequences

The transport no longer requires a string proportional to the whole response;
the existing provider projections are still constructed in memory. Client code
that aggregates an enormous response into a single string can still hit its own
limit. Reader first-load performance is a separate acceptance requirement.

## Verification

`test/json-stream.test.mjs` checks native byte equivalence, Unicode at both
source and output chunk boundaries, repeated references, backpressure,
disconnect and explicit errors. `test/routes.test.mjs` exercises both complete
routes over real HTTP. Independent stream review and 18 focused tests pass.

Stable real compact API (21,060,836 bytes) and pretty export (23,527,557 bytes)
retain their exact pre-change SHA-256. A separate incremental JSON parser reads
the previously failing active root to EOF: API 721,594,014 bytes in 29.5 seconds,
export 719,659,858 bytes in 28.5 seconds, each with all five root fields. The
active history grows between requests; API and export also intentionally have
different message projections. Follow-up seven-provider health requests return
in 7–10 ms. No new serialization or response-header errors occur in the restarted
service log. Private response hashes and validation logs remain in ignored
`tmp/json-stream-*.log`; no provider body is committed.
