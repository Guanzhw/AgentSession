---
status: implemented
date: 2026-09-27
decision: Link each Claude task notification to its exact canonical Reader event.
---

# Claude task notification Reader navigation

## Context

Claude task notifications are recorded as Reader events and also appear as
relation tasks. A task ID can repeat across notifications, and the provider may
omit status. Displaying only the task ID, status, and source record ID does not
let a reader open the exact notification body.

## Decision

The Claude relation task retains an optional canonical `reader_event` reference
to the notification's provider, owning session, source UUID, and `tool` segment.
The Reader links to that event's exact anchor and body. The task's recorded
status remains unchanged; an absent status is `unknown`. Browser Back returns to
the task panel and restores focus to the originating link. Child notifications
are opened through the existing canonical child-session route and navigate
within that Reader.

## Alternatives considered

- Resolve a notification by task ID: repeated IDs can select the wrong source.
- Link only the raw source ID: it does not open the notification body in Reader.
- Infer a missing status or task lifecycle: the source does not record it.

## Consequences

Each recorded notification can be reviewed at its exact source event, including
when task IDs repeat. This links existing relation evidence; it does not infer a
child session, run lifecycle, or terminal status. Providers without a canonical
Reader event leave the optional reference absent.

## Verification

- `cargo test --manifest-path v3/Cargo.toml -p agentsession-core providers::claude_code --locked --offline` passed 6/6.
- `node --test v3/test/claude-rust-slice.test.mjs` passed 5/5; its private-manifest test was skipped because no manifest was selected.
- `npm run build --prefix v3/ui`, `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3 --locked --offline`, and `cargo fmt --manifest-path v3/Cargo.toml --all -- --check` passed.
- Browser coverage opened the exact root and canonical child notification bodies and anchors; Back restored focus to each originating task link. Public fixture and isolated provider-file hashes remained unchanged.
- The available frozen Claude transcript retained its expected SHA-256 `ee5e4cca0777b45ef7e97306139ad53022233a95e364ca314734890d14190734` and 26 lines.
