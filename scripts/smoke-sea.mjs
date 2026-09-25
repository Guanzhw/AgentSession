import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = path.resolve(import.meta.dirname, "..");
const binaryDir = path.resolve(process.argv[2] || path.join(root, "artifacts", "binaries"));
const extension = process.platform === "win32" ? ".exe" : "";
const viewer = path.join(binaryDir, `agentsession${extension}`);
const mcp = path.join(binaryDir, `agentsession-mcp${extension}`);
const metadata = JSON.parse(readFileSync(path.join(binaryDir, "binary-metadata.json"), "utf8"));
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const expectedProviderIds = ["opencode", "claude-code", "codex", "pi", "deepseek-harness"];
const staticAssets = [
  { path: "style.css", contentType: "text/css; charset=utf-8", marker: ":root", minLength: 1000 },
  { path: "app-shell.css", contentType: "text/css; charset=utf-8", marker: ":root", minLength: 1000 },
  { path: "reader.css", contentType: "text/css; charset=utf-8", marker: ".session-workbench", minLength: 1000 },
  { path: "library.css", contentType: "text/css; charset=utf-8", marker: ".session-list-library", minLength: 1000 },
  { path: "app.js", contentType: "application/javascript; charset=utf-8", marker: "function", minLength: 1000 },
  { path: "vendor/highlight.js/highlight.min.js", contentType: "application/javascript; charset=utf-8", marker: "hljs", minLength: 1000 },
  { path: "vendor/highlight.js/github.min.css", contentType: "text/css; charset=utf-8", marker: ".hljs", minLength: 1000 },
  { path: "vendor/highlight.js/LICENSE.txt", contentType: "text/plain; charset=utf-8", marker: "BSD 3-Clause", minLength: 500 },
  ...[
    "book-open.svg",
    "chart-no-axes-column.svg",
    "chevron-down.svg",
    "ellipsis.svg",
    "external-link.svg",
    "moon.svg",
    "network.svg",
    "search.svg",
    "settings-2.svg",
    "star.svg",
    "sun.svg",
    "x.svg"
  ].map((name) => ({
    path: `vendor/lucide/${name}`,
    contentType: "image/svg+xml; charset=utf-8",
    marker: "<svg",
    minLength: 100
  })),
  { path: "vendor/lucide/LICENSE", contentType: "text/plain; charset=utf-8", marker: "ISC License", minLength: 500 },
  { path: "vendor/lucide/README.md", contentType: "text/plain; charset=utf-8", marker: "Lucide UI icons", minLength: 100 }
];
if (metadata.version !== packageVersion) throw new Error("Binary metadata version does not match package version");

for (const [executable, expected] of [[viewer, "AgentSession —"], [mcp, "AgentSession-MCP"]]) {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8" });
  if (help.status !== 0 || !help.stdout.includes(expected)) {
    throw new Error(`Binary help smoke failed for ${path.basename(executable)}: ${help.stderr}`);
  }
}


const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-sea-smoke-"));
const viewerEnv = {
  ...process.env,
  AGENTSESSION_META_PATH: path.join(temp, "viewer-meta.db"),
  AGENTSESSION_CONFIG: path.join(temp, "viewer-config.json")
};
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const selectedPort = typeof address === "object" && address ? address.port : null;
    probe.close((error) => error ? reject(error) : resolve(selectedPort));
  });
});
if (!port) throw new Error("Could not reserve a local SEA smoke port");
const server = spawn(viewer, [
  "--port", String(port),
  "--disable-terminal-launch",
  "--opencode-db", path.join(temp, "missing-opencode.db"),
  "--claude-dir", path.join(temp, "missing-claude"),
  "--codex-dir", path.join(temp, "missing-codex"),
  "--pi-dir", path.join(temp, "missing-pi"),
  "--dsh-dir", path.join(temp, "missing-dsh")
], { stdio: ["ignore", "pipe", "pipe"], env: viewerEnv });
let serverStdout = "";
let serverStderr = "";
server.stdout.on("data", (chunk) => { serverStdout += chunk; });
server.stderr.on("data", (chunk) => { serverStderr += chunk; });

try {
  let providersResponse = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      providersResponse = await fetch(`http://127.0.0.1:${port}/api/providers`);
      if (providersResponse.ok) break;
    } catch {}
    await delay(100);
  }
  if (!providersResponse?.ok) {
    throw new Error(`Viewer binary did not become ready\n${serverStdout}\n${serverStderr}`);
  }
  const providers = await providersResponse.json();
  if (!Array.isArray(providers)
    || JSON.stringify(providers.map((provider) => provider.id)) !== JSON.stringify(expectedProviderIds)) {
    throw new Error("Viewer binary returned an invalid provider list");
  }
  for (const asset of staticAssets) {
    const response = await fetch(`http://127.0.0.1:${port}/static/${asset.path}`);
    const body = await response.text();
    if (!response.ok || response.headers.get("content-type") !== asset.contentType || body.length < asset.minLength || !body.includes(asset.marker)) {
      throw new Error(`Embedded ${asset.path} is unavailable or has the wrong content type`);
    }
  }
} finally {
  server.kill();
}

const configPath = path.join(temp, "mcp-config.json");
writeFileSync(configPath, JSON.stringify({
  dbPath: path.join(temp, "missing-opencode.db"),
  claudeDir: path.join(temp, "missing-claude"),
  codexDir: path.join(temp, "missing-codex"),
  piDir: path.join(temp, "missing-pi"),
  dshDir: path.join(temp, "missing-dsh")
}));
const transport = new StdioClientTransport({
  command: mcp,
  args: ["--config", configPath],
  env: { ...process.env, AGENTSESSION_META_PATH: path.join(temp, "mcp-meta.db") },
  stderr: "pipe"
});
const client = new Client(
  { name: "agentsession-sea-smoke", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } }
);
await client.connect(transport);
try {
  if (client.getServerVersion()?.version !== packageVersion) {
    throw new Error("MCP binary server version does not match package version");
  }
  if (client.getProtocolEra() !== "modern") {
    throw new Error("MCP binary did not negotiate protocol 2026-07-28");
  }
  const tools = await client.listTools();
  const expectedTools = [
    "session_get",
    "session_get_context",
    "session_get_event",
    "session_search",
    "session_timeline"
  ];
  if (JSON.stringify(tools.tools.map((tool) => tool.name).sort()) !== JSON.stringify(expectedTools)) {
    throw new Error("MCP binary tool surface is incorrect");
  }
  const search = await client.callTool({
    name: "session_search",
    arguments: { query: "binary-smoke-no-match", providers: expectedProviderIds }
  });
  if (search.isError || !search.structuredContent?.untrustedContent) {
    throw new Error("MCP binary search smoke failed");
  }
} finally {
  await client.close();
}

console.log(JSON.stringify({
  version: packageVersion,
  platform: process.platform,
  arch: process.arch,
  viewer: true,
  embeddedAssets: true,
  mcpTools: 5
}));
