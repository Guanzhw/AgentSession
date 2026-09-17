# Saved outputs beside the source history

Status: implemented slice, 2026-09-17. This implements the readable-output
part of P7 using the [observed Codex evidence](context-generation-evidence.md).

## Content and presentation

At the beginning of a Reader pane, a quiet native disclosure says “Saved from
this history” and identifies available memory notes / session summary. Opening
it reveals the input history, the captured input date and generated date, then
the two readable outputs. A short branched connector expresses one source
producing two outputs; it does not imply a known generating session.

Each output has its own disclosure and bounded Markdown continuation. The
complete retained body is reachable. Metadata and matching background-job
evidence are secondary. An unavailable generating transcript is stated next
to that evidence; the input history is never relabeled as its producer.

The section is separate from chronological messages because a generated date
alone does not identify a transcript insertion point. Output text does not
enter the conversation ToC, message search or token totals. No output becomes
an assertion that a later request used it.

## Visual presentation

Reuse the accepted Reader design: left-aligned content, existing body type and
18px readable prose, compact interface labels. Existing semantic palette:
page `#f6f7f9`, panel `#ffffff`, text `#202832`, secondary `#586777`, boundary
`#d4dce5`, accent `#245bcc`; dark mode uses the existing paired tokens.
The connector and output titles carry the hierarchy; avoid another dashboard
or repeated metric cards. On narrow screens the same source-to-output relation
stacks vertically, with full reading width and visible keyboard focus.

```text
Saved from this history                         [expand]
  Source history · captured date
  ├─ Memory notes                               [read]
  └─ Session summary                            [read]
     Generation date · generation evidence      [details]
```

Review against the brief: this keeps the original transcript readable and
adds actual saved content, rather than substituting an abstract graph. Only
the source/output relationship is visualized; body text stays continuous.

## Data contract

- Provider-owned memory metadata enters existing v2/v3 ContextArtifact arrays.
  Artifact ID includes source version, generation time and exact body hash.
- `contentSourceTime` is the recorded input update time; `productionEvidence`
  is present only for a current job matching source key, input watermark,
  successful state and completion time. It carries provenance and times, not
  a worker-as-producer session reference.
- `contextArtifactSourceState` describes additional readable artifact storage,
  not overall compact/context coverage. Missing/invalid stores stay explicit;
  missing job evidence does not remove saved content.
- An optional `getProtocolRevision(sessionId)` avoids invalidating token stats
  when memory changes. Request snapshots reuse captured artifact metadata.
- An optional `getContextArtifactContent(sessionId, artifactId)` reads one
  selected version. The bounded read-only content route returns 409 for a
  replaced version, with an explicit refresh path instead of mixed contents.

## Acceptance

Read both complete outputs from a real source session, compare all pages with
the SQLite body, and confirm generation/source identity remains distinct.
Check current job matching and mismatch, missing/invalid storage, empty bodies,
WAL changes, stale continuation, transient failure/retry, keyboard expansion,
390px and light/dark themes. Preserve seven-provider Reader behavior. Phase2
log history, dream evidence and full product acceptance remain separate work.

## Verified checkpoint

- `npm test`: 880/880. The 29 focused artifact, revision, route, rendering and
  progressive-loader tests also pass on Node 22.15.0. Independent review passed
  after explicitly separating a matching job from unavailable generation history.
- Two real Codex inputs retain memory/summary bodies of 1,798 / 1,715 and
  6,268 / 7,665 UTF-16 characters. All six response pages match the exact
  SQLite bodies. Session, messages, tree, container and metrics API field
  hashes are unchanged from before the implementation for both inputs.
- A third real input's 8,371-character memory and 10,942-character summary
  each reach the end in two browser-loaded pages. Keyboard expansion,
  same-history source navigation, transient abort/retry and simulated stale
  409 responses work. Stale continuation preserves the first page and offers
  the owning history's canonical refresh link; provider data was not modified.
- English and Chinese, light and dark, 1280px and 390px were inspected on the
  live Reader. Narrow pages have no full-page horizontal overflow; body text
  computes to 18px / 29.7px line height, including inside the shared progressive
  Markdown renderer. The Chinese service used isolated viewer metadata.
- Seven installed provider Reader/page/preview/runtime checks and the full
  `qa:e2e` suite pass, with no browser errors. Service error logs are empty.
- A scoped axe check reports one `heading-order` best-practice finding in the
  retained source Markdown (`h3` after the page heading). Source headings remain
  intact; this is tracked under the still-open P11 semantic-heading review,
  not reported as a full accessibility pass.

Private outputs/screenshots use `tmp/p7-memory-*`; source histories, bodies and
screenshots are not committed. The broader remaining work stays in the
[acceptance record](runtime-acceptance-evidence.md).
