# Public usage certificate challenges

These synthetic JSONL rows are a small public challenge set for checking the
evidence rules used by a hand-curated Codex request-usage certificate. They are
not product output, a production parser fixture, a corpus sample, or a source
of certificates generated from the product cache. The set deliberately keeps
an unresolved occurrence so verification success does not require assigning
every observed row to a unique request.

`sourceSha256` hashes each complete JSONL file as checked out. `rawHash` hashes
the selected line bytes without its LF delimiter. `.gitattributes` keeps those
fixture bytes stable across platforms.

Response uniqueness is checked only within the source bundle supplied to the
verifier. This fixture bundle is intentionally incomplete, so its
`proved-request` rows are challenge outcomes and do not establish a
corpus-wide unique-request gold. A full-corpus result needs a complete
independent source manifest and a streaming raw-row extraction pass first.

Mirror proofs require an explicit response ID and one uninterrupted usage
chain from the complete baseline through the canonical request to the selected
legacy row. Context snapshots stop at any intervening usage row. Parent-copy
proofs require a unique matching `NEW_TASK` boundary and exactly one parent and
one child content occurrence across the supplied bundle. Extra owner boundaries
or usage rows in the parent or child chain leave the occurrence unresolved.
