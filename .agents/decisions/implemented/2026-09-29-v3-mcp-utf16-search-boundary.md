---
status: implemented
date: 2026-09-29
decision: Preserve lone UTF-16 surrogate search queries at the MCP stdio boundary
---

## Context

AgentSession 2.0 accepts JSON-escaped lone UTF-16 surrogates in `session_search` and matches either code unit of an emoji. Rust `String` cannot represent those units. The 3.0 rmcp stdio transport rejected the escaped request during JSON decoding and did not return a response. NUL queries and complete Unicode scalar queries already worked.

## Decision

The 3.0 app stdio input adapter passes ordinary JSON lines unchanged. For a lone surrogate escape only in `session_search`'s `query`, it rewrites that escape to a JSON-decodable replacement and carries the exact original UTF-16 units in a bounded, private request-ID sidecar. Exceptional requests with duplicate JSON keys are rejected because the raw query span could otherwise disagree with the parsed request's last-key-wins shape. A reserved internal marker on the rewritten request must match the sidecar; missing, stale, mismatched, and client-supplied markers fail explicitly. The MCP handler consumes the sidecar once. Rust core search matches those units against whole-string-lowercased UTF-16 source text, preserving contextual folds such as Greek final sigma within valid runs and retaining lone surrogate units. It scans indexed documents before choosing the first matching document and binds the exact units into cursor identity. Invalid lone surrogates outside that query receive an explicit JSON-RPC error. The adapter serializes these errors with rmcp output on one stdout writer.

## Alternatives considered

A private-use character substitute would collide with literal source text and could not match half of a valid emoji. Changing all MCP calls to a custom transport would expand the affected boundary. Replacing the 2.0 behavior with input rejection would break an observed query contract.

## Consequences

The exceptional query path scans indexed documents without trigram narrowing. Its sidecar is bounded and expires if a request is cancelled before the handler consumes it; a request processed after expiry returns `invalid_input`. The regular search path and other valid MCP requests remain unchanged.

## Verification

The public copied Codex fixture test `v3/test/mcp-search-json-boundary.test.mjs` failed 2/2 on the exact `6d629d04` Windows candidate and passed 2/2 on the debug build in both MCP lifecycle eras. It covers both surrogate halves, literal PUA, NUL, canonical events, two-page continuation, wrong-query cursor rejection, client-supplied markers, invalid non-search input, and follow-up connection health. The later contextual-sigma addition failed 2/2 on the pre-fix debug binary: `\uD83D ΟΣ` returned no hits for two `🙂 ΟΣ` sources. A duplicate-`arguments` Rust regression panicked on the pre-fix implementation at `mcp_input.rs:308`. After the fixes, `cargo test --manifest-path v3/Cargo.toml -p agentsession-core search` passed 14/14; `cargo test --manifest-path v3/Cargo.toml -p agentsession-v3 mcp_input` passed 4/4, including duplicate `params`, `arguments`, `query`, `name`, and `method` keys. `cargo build --manifest-path v3/Cargo.toml -p agentsession-v3` produced debug SHA-256 `b0d4ffbc31e777ab3030e3523cecaba53d127cb26a3e55cf3357b21059e1ad52`; `node --test v3/test/mcp-search-json-boundary.test.mjs` passed 2/2 against that binary, including contextual sigma. The relevant six-file Node MCP suite passed 24/25 with one private-corpus opt-in skip before the marker adjustment; after the adjustment and before these last two fixes, the focused two-file suite passed 11/12 with one private-corpus opt-in skip. `cargo fmt --manifest-path v3/Cargo.toml --all --check` and `npm run check:governance` passed after the last two fixes.
