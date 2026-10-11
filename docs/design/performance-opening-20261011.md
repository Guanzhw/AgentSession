# Page opening performance follow-up, 2026-10-11

The retained change starts the first Library page request alongside provider
discovery. Rows, errors, restored pages and browser history still publish through
the original lifecycle after discovery succeeds. A route-generation check also
prevents a late Library response from overwriting Reader history after navigation.

## First-opening evidence

On the deployed `63b1ff9` native build, the actual desktop browser loaded the
HTML in 6.1 ms and reached the loading-text first paint at 128 ms. Provider
discovery started at 69.9 ms and took 353.8 ms; the first Library request started
only at 424.9 ms and took 8,885.1 ms. The change removes that serial request gap.
Loading-text paint is not a measurement of readable session data.

After deploying the retained UI, the real Library page started its first request
at 75.1 ms and provider discovery at 75.2 ms. Discovery took 272.9 ms and the
Library request took 8,870.9 ms. Forty rows became visible. This verifies request
overlap; the changing live corpus and earlier partial response do not support an
end-to-end percentage comparison.

The live response omitted Codex with an explicit source-change diagnostic while
the approximately 985 MB selected recorded rollout was being appended. A second
API observation took 6,156.8 ms and was also partial. Neither response is counted
as successful complete-data performance evidence. `available: true` describes
source access, not successful refresh. Source selection, hashing, indexing and
partial-source behavior are unchanged by the retained frontend change.

## Rejected backend experiment

A distinct index capture kept summaries and searchable documents while skipping
Reader previews, UTF-16 counts and retained tool payloads. It continued using the
complete existing parser and exact source checks. Other providers converted
their full capture, and Codex projected directly after parsing. The candidate
preserved all measured outputs, but did not provide stable opening-speed gains,
so its source and tests were removed.

The corpus was the existing frozen real 917,848,369-byte parent, SHA-256
`878ae36e1999eb615856bf96a458357e15803e4e839b4788ba784e2edcd8c4db`.
A synthetic alternate header and task-owned native authority exercised the
recorded-rollout branch. Both arms used this same read-only corpus and fresh,
isolated derived state. This isolates indexing cost; it does not represent the
complete live inventory, child history or native authority database.

| Run | Baseline cold request | Candidate cold request | Baseline peak | Candidate peak |
| --- | ---: | ---: | ---: | ---: |
| 0 | 5,686 ms | 6,418 ms | 505 MiB | 471 MiB |
| 1, reverse order | 5,800 ms | 6,274 ms | 504 MiB | 471 MiB |
| 2 | 5,654 ms | 5,747 ms | 504 MiB | 469 MiB |

Cold medians were 5,686 and 6,274 ms: about 10.3% slower in the candidate.
Peak working-set medians fell about 6.5%. Warm requests were also not faster:
baseline trials averaged 542–566 ms and candidate trials 577–621 ms. Filesystem
cache and background host activity were uncontrolled; the data establishes no
stable speed benefit, rather than attributing the observed regression to a
particular instruction. The full Library JSON, stored catalog and all 26,224
search rows had identical digests across every run. Source hashes were unchanged.

The rejected native artifact SHA-256 was
`330e4883f91e370b1a04dba47fa6f6b3479a63e813ec4e71f906e4c2fd41d9b8`;
the baseline was `9fa1825d31b32dc27c3cfdb3dbf7351ce6ef691c46fb99f8c3ae09e76f7af6ab`.
Machine-local scripts, six measurement records and the rejected diff are retained
outside the repository at `D:/CodexArtifacts/OpenSession/20261011-opening`.
The [rejected decision](../../.agents/decisions/rejected/2026-10-11-index-capture-projection.md)
preserves the implementation choice and its outcome.

## Validation and remaining cost

The retained browser regression uses controlled discovery/page gates. It first
failed on serial fetching, then passed after prefetch. A second RED reproduced
the late-response history race. Checks cover no early publication, one first-page
request, discovery and Library error ownership, abandoned rejected promises,
restored 80 canonical rows with cursor continuation, and stale responses before
and after discovery completes. The seven-case opening suite and UI build passed.

The retained native build and `npm run review` passed. The four-suite browser
command covering opening/Back, Library keyboard focus, real-source failures and
WEB01 reported 11 passes, zero failures and one explicit WEB01 opt-in skip. The
final test-only discovery barrier was then checked with the focused prefetch
test (one pass). Existing opening-suite evidence covers all seven cases. Full
root tests and CI are separate from this local affected-surface evidence.

The task-owned service was restarted on port 3457 with the retained native
artifact, SHA-256
`136c24217edf900d727d5a79f5ca1fc06d5ec3456a630541aae93a25f8166afc`.
HTTP `/sessions` returned 200, `/api/providers` returned five providers, and
settings were identical before and after restart. The actual desktop Reader
opened the canonical parent, displayed its title and transcript, and completed
automatic TOC hydration (`aria-busy=false`). Its bootstrap took 7,322 ms; content
requests took 5 and 20 ms. The remaining TOC pages finished about 0.92 seconds
after bootstrap completion. Reader behavior is unchanged by this Library patch;
these observations locate residual cost rather than establish a Reader gain.

The largest remaining opening costs are full parsing, repeated exact reads for
selected recorded sources and catalog refresh during active writes. Addressing
those requires a separately tested source/freshness design; the smaller tested
projection did not justify additional runtime complexity.
