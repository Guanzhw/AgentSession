---
status: implemented
date: 2026-09-02
decision: Remove Gemini CLI and GitHub Copilot CLI provider support from the public AgentSession contract
---

## Context

The provider evidence matrix records Gemini CLI and GitHub Copilot CLI as
outside the continuing provider scope. Their adapters were compatibility
residue, while registration, configuration paths, package metadata, MCP
schemas, documentation, and lifecycle badges still advertised them as
supported providers.

## Decision

Remove both adapters and their provider-owned paths, IDs, registrations,
capability metadata, icons, locales, lifecycle badge plumbing, dedicated
fixtures/tests, and current support documentation. Keep historical changelog
and completed protocol specification evidence factual. The MCP installer host
set remains Codex, Claude Code, and OpenCode; only its stale Copilot wording is
removed. Normalize retired top-level and provider-keyed project/resume settings
out of both runtime configuration and subsequently saved configuration.

## Alternatives considered

- Keep the adapters as hidden legacy readers: rejected because this preserves
  an unsupported public/provider contract and orphaned maintenance surface.
- Keep configuration paths while hiding the providers: rejected because it
  continues to claim support and scans provider-owned data unnecessarily.

## Consequences

The public provider registry, config surface, MCP provider enum, package
metadata, docs, and smoke expectations now cover seven providers. Existing
provider-owned Gemini/Copilot data is not modified or migrated. Historical
records describing the former adapters remain historical evidence.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed (core and MCP workspace builds).
- `node --test test/provider-removal.test.mjs test/runtime-protocol-missing-providers.test.mjs test/mcp.test.mjs test/routes.test.mjs` — 32 passed, 0 failed.
- `npm test` — 307 passed, 0 failed (final run after all source/test changes).
- `npm run check:governance` — passed.
- Live `/api/providers` returned exactly the seven supported providers without
  a lifecycle field; `/api/gemini/sessions` and `/api/copilot/sessions` returned
  HTTP 404.
- `npm run qa:e2e` — passed against the rebuilt local server with no browser
  errors.
