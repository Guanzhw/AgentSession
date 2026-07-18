# Unified Sessions and Usage Explorers

AgentSession has two provider-neutral entry points:

- `/sessions` lists sessions from every detected provider.
- `/stats` aggregates normalized token usage from every detected provider.

Provider IDs are filters on these pages, not primary navigation destinations.
Canonical detail URLs remain `/:provider/session/:sessionId` because a session ID
is only unique inside its owning provider and provider adapters retain ownership
of transcript parsing, resume behavior, structured views, and source paths.

## Sessions data flow

All adapters populate the viewer-owned `session_index` table at startup. The
global query reads this index by the composite `(provider, id)` identity and
applies time, title/directory, project, sort, and session-kind filters in one
bounded SQL query. Viewer deletion metadata is translated into provider-aware
exclusions, so equal session IDs from two providers cannot hide each other.

The page and `/api/sessions` return the source provider with every row. Infinite
scroll therefore builds the correct canonical detail link after the first page
as well as during the server-rendered initial response. Provider-specific pages
and APIs remain available for compatibility and for provider-owned operations
such as starring, renaming, deletion, content search, and resume.

## Usage data flow

Every adapter exposes normalized daily token components through the shared
statistics contract: input, output, reasoning, cache read, cache write, total,
and message count. `/stats` requests the selected providers with the same UTC
date range, merges rows by day, and presents a provider breakdown alongside the
combined trend. The total trend is the primary visualization, with provider
checkboxes presented directly as chart filters for multi-provider comparison.
Provider contribution cards follow the chart as drill-down context; a card
offers separate actions to apply that provider as a single-value filter without
leaving `/stats` or open the provider-specific details page. The selected card
restores all available providers, and every action preserves the active date
range.
File-backed providers honor custom ranges by filtering their daily aggregates
after bounded collection.

The global page exposes only capabilities whose meaning is provider-neutral.
Project/model filters, coverage, session rankings, cost estimates, and day
drill-down remain on provider-specific statistics pages until every adapter can
supply those facts with equivalent semantics. This avoids presenting partial
data as a complete cross-provider comparison.

## Performance model

Session lists query the persistent cross-provider SQLite index and never scan
transcript files per request. Token statistics use the persistent incremental
statistics index for SQLite-backed providers and adapter revision caches for
file-backed providers. Query results are cached by provider, source fingerprint,
range, and detail level; the global page composes those cached provider results.
Historical daily buckets are immutable, while the current day is refreshed when
the source fingerprint changes.

## Compatibility rules

- `/` redirects to `/sessions`.
- Existing `/:provider`, `/:provider/search`, and `/:provider/stats` URLs remain
  valid.
- Session detail, export, local management, settings, and trash routes retain
  provider scope.
- Unavailable providers appear disabled in global filters and are never queried.
