---
status: implemented
date: 2026-09-17
decision: Preserve recorded user question-answer replies as typed presentation beside raw text
---

## Context

Four real Codex `user.text` records contain a complete
`send_user_message_question_reply` envelope with an array of
`questionItemId`, `question`, and `answer` strings. The reader currently shows
the envelope as prose. No separate record for those question item IDs was found.

## Decision

Recognize the envelope only at the Codex provider boundary. Keep raw message
content, text parts, canonical IDs, provenance, and exported raw text unchanged; attach
a provider-neutral typed question-answer presentation. Propagate it through
both the reader tree and mapped document. Readable questions and answers share
one `question-answer` search/continuation field. The existing `text` field
continues to expose the complete raw record in a disclosure. ToC and bounded
task previews use the same readable projection. Display labels and
the raw duplicate do not contribute default search occurrences. Preserve one
user turn and one canonical source part; do not infer a tool relationship.

## Alternatives considered

Replacing message content would change raw exports and legacy source matching.
Parsing in the browser would put provider semantics beyond the owning boundary.
Changing only HTML would leave search offsets and continuation inconsistent.

## Consequences

The normalized message gains an optional typed presentation and the content
API gains the `question-answer` field. Unknown or malformed envelopes retain
their complete ordinary text representation. Other providers can continue
using the existing text contract without detecting Codex syntax.
Normalized JSON messages, tree/container parts, and JSON exports may include
the additive `questionAnswers` presentation beside the unchanged raw fields.

## Verification

- `npm run build` passed.
- `node --test test/question-answer-presentation.test.mjs test/codex-provider.test.mjs test/message-presentation.test.mjs test/session-reader.test.mjs test/reader-client-state.test.mjs`: 42/42 passed.
- `npm run review` passed governance checks and TypeScript checking.
- A read-only check of the four recorded Codex replies recognized all four;
  message/tree/document raw text and canonical part IDs were unchanged. Private
  question/answer text was omitted from the verification output.
- Independent review found the task preview still exposing raw text; the shared
  readable projection now also serves previews, with source IDs, escaping, and
  the 400-character bound covered by regression tests.
- Final integrated suite: 758/758. Full live E2E, seven installed-provider
  Reader/API/preview checks, and Windows binary smoke passed.
- A real two-question Codex reply rendered as one user turn on desktop and
  390px layouts. Raw text remained complete behind a closed disclosure. Search
  found one occurrence even with raw text expanded; refresh retained readable
  presentation. API search/content offsets and source IDs matched the browser.
  Long question-answer continuation is covered by fixtures, not a real long
  reply. OpenClaw and Pi cross-provider samples were local smoke transcripts.
