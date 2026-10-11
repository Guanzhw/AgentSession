# 3.0 prerelease follow-through

Updated: 2026-10-11. Baseline: published `v3.0.0-rc.4`, commit
`d74d5088388118d8df7dd622a7ef17f4be0c73ed`.

This specification turns the post-release audit into bounded implementation and
verification. [Design](design.md) owns the implementation choices;
[tasks](tasks.md) records execution and evidence. The existing
[acceptance contract](../../design/agentsession-v3-acceptance-contract.md) still
owns stable-release product, source and resource gates.

## Outcome

An npm user can discover and execute the metadata-copy upgrade path, preserve
both old and already-created Viewer state, and distinguish executed validation
from unavailable private-source coverage. Release status points to the actual
published candidate and leaves remaining acceptance work actionable.

## Requirements and acceptance

| ID | Required behavior | Acceptance |
| --- | --- | --- |
| UPG-01 | The Viewer npm command exposes the native migration command advertised by its help. | An actual packed/installed Viewer accepts `agentsession migrate-meta --from <copy> --config <config>`, imports expected titles/stars, preserves input bytes, and rejects a repeated import. Help and version work through the installed entrypoint. |
| UPG-02 | Existing default Viewer invocation and the separate MCP command keep working. | Installed default/option-only Viewer starts on an isolated port; explicit native subcommands and global config placement have consistent argument forwarding; actual HTTP and stdio MCP checks pass. Arguments that are option values never become commands. |
| UPG-03 | Upgrade instructions put import before the first Viewer metadata edit and explain the existing-target case. | Both root READMEs link to one operational guide. That guide covers published rc.4's standalone migration route, the corrected npm route's unreleased status, backup/copy, matching source scope, and a new isolated `metaDir` when the selected scope already has state. No merge or overwrite is implied. |
| VAL-01 | Private-source tests cannot report success without executing source assertions. | The two identified Rust tests are explicitly ignored by default, with documented opt-in commands. An explicit run without its required manifest fails with a clear prerequisite; supplied real-source evidence is reported separately. |
| DOC-01 | Current release state reflects the successful exact-tag workflow. | Changelog, prerelease validation, delivery plan and platform acceptance entries distinguish rc.4's four-host build/install/Web/MCP evidence from remaining real-source, desktop preference and resource gates. Historical outcomes retain their identities. |
| DOC-02 | A newly published package missing from a mirror has a concrete troubleshooting path. | Install documentation shows a one-command official-registry override without changing global npm configuration, and distinguishes that failure from an unavailable release. |
| GATE-01 | Remaining stable-release work has explicit evidence requirements. | A short gate table records latest/rare provider samples, end-to-end Reader and shared-process resources, user usability evidence, and historical state attribution; none is closed by packaging CI alone. |

## Preserved contracts

Provider records stay read-only. Metadata import remains copy-based, source-scope
isolated and refuses an existing target. Tests use owned temporary state and
public fixtures or explicitly selected read-only source copies. Existing user
services and configuration are preserved. Published rc.4 artifacts and tags are
immutable; fixes in this specification are a subsequent unreleased change.
