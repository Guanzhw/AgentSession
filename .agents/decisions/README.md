# Decision records

Decision records preserve the small set of choices that future agents cannot
reliably recover from source alone. They are intentionally narrower than a
design specification: record the context, chosen/rejected option, trade-offs,
and evidence needed to verify the result.

Use one of these lifecycle directories:

- `proposed/` — an unresolved choice under discussion.
- `implemented/` — a shipped choice and its current factual realization.
- `rejected/` — a considered choice that was explicitly declined.

Name records `YYYY-MM-DD-short-kebab-title.md`. Every record has front matter
with `status`, `date`, and `decision`, followed by these headings:
`Context`, `Decision`, `Alternatives considered`, `Consequences`, and
`Verification`. Keep the headings in that order and give each one content.
`npm run check:governance` checks this shape, real calendar dates, matching
filename dates, and the directory status.

Do not create a note for routine bug fixes, isolated tests, copy changes, or
mechanical refactors. If an implemented decision is reversed, add a new record
and link the two; do not rewrite history to hide the reversal. Keep records
short and link to source/docs for details.
