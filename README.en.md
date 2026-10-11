# AgentSession

AgentSession 3.0 is a local-first reader for AI coding work history. The sole
implementation in this workspace uses Rust, Axum, native rmcp stdio MCP, and a
Svelte frontend. It reads OpenCode, Claude Code, Codex CLI, Pi, and DeepSeek
Harness sessions into the Library, Reader, search, statistics, and Runtime views.

Provider databases and transcripts remain read-only. Stars, titles, and Viewer
Trash use separate metadata. Canonical provider/session identity and recorded
evidence remain visible throughout the reading and MCP flows.

[中文](README.md) · [Native CLI, configuration and MCP](v3/README.md) ·
[Acceptance contract](docs/design/agentsession-v3-acceptance-contract.md)

## 3.0 prerelease

```sh
npm install -g @acetamido/agentsession@3.0.0-rc.1
npm install -g @acetamido/agentsession-mcp@3.0.0-rc.1
agentsession
```

The prerelease uses npm's `next` channel. [Release and upgrade notes](docs/releases/3.0.0-rc.1.md)
compare it with public v1.10.1, including the port change, metadata-copy import,
and MCP/API migration. Four standalone platform bundles are available in the
[GitHub Release](https://github.com/Guanzhw/AgentSession/releases/tag/v3.0.0-rc.1).

## Run from source

Development requires Node.js 22.15 or newer and Rust with edition 2024 support.

```bash
npm install
npm --prefix v3/ui ci
npm run build
npm start
```

Open [the local Viewer](http://127.0.0.1:3457). Root installation has no prepare
build. UI installation is explicit; `npm run build` builds the UI and locked
Rust release. `npm start` builds and starts that native Viewer. Forward options
with `npm start -- --port 3458 --disable-terminal-launch`.

For the already-built binary, run `v3/target/release/agentsession-v3 serve`
(`.exe` on Windows), or use its `mcp` subcommand for native stdio MCP.
Standalone binaries need neither Node nor Cargo at runtime.

## Development and status

```bash
npm run review
npm test
```

See [the development guide](AGENTS.md) for ownership and validation, and the
[delivery plan](docs/design/agentsession-v3-delivery-plan.md) for remaining
source, performance, product, and platform gates. The prerelease notes identify
the validated release scope; unresolved acceptance items remain open. Historical 2.0
evidence and migration decisions retain their original scope; its implementation
can be recovered from Git history.

## License

MIT
