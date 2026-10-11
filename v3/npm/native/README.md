# AgentSession native runtime

This package supplies the native runtime shared by
[`@acetamido/agentsession`](https://www.npmjs.com/package/@acetamido/agentsession)
and [`@acetamido/agentsession-mcp`](https://www.npmjs.com/package/@acetamido/agentsession-mcp).
Supported pairs are Windows x64, Linux x64, Linux arm64, and macOS arm64.

Install the Viewer or MCP package to use its command. The launcher requires
Node.js 22.15 or newer; the packaged runtime requires neither Cargo nor an
additional download. `provenance.json` pins each native payload to its selected
portable bundle and records the publication source commit.

See [AgentSession](https://github.com/Guanzhw/AgentSession) for configuration,
provider support, and prerelease acceptance status.
