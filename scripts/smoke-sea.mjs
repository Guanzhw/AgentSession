import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const binaryDir = path.resolve(process.argv[2] || path.join(root, "artifacts", "binaries"));
const extension = process.platform === "win32" ? ".exe" : "";
const viewer = path.join(binaryDir, `agentsession${extension}`);
const mcp = path.join(binaryDir, `agentsession-mcp${extension}`);
const metadata = JSON.parse(readFileSync(path.join(binaryDir, "binary-metadata.json"), "utf8"));
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (metadata.version !== packageVersion) throw new Error("Binary metadata version does not match package version");

for (const [executable, expected] of [[viewer, "AgentSession —"], [mcp, "AgentSession-MCP"]]) {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8" });
  if (help.status !== 0 || !help.stdout.includes(expected)) {
    throw new Error(`Binary help smoke failed for ${path.basename(executable)}: ${help.stderr}`);
  }
}

const internalTool = spawnSync(viewer, ["--internal-analysis-tool"], { encoding: "utf8" });
if (internalTool.status !== 2 || !internalTool.stderr.includes("analysis-tools.js")) {
  throw new Error("Binary internal analysis-tool dispatch failed");
}
const internalValidator = spawnSync(viewer, ["--internal-analysis-validator"], { encoding: "utf8" });
if (internalValidator.status !== 2 || !internalValidator.stderr.includes("analysis-validator.js")) {
  throw new Error("Binary internal validator dispatch failed");
}

const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-sea-smoke-"));
const port = 35000 + (process.pid % 20000);
const server = spawn(viewer, [
  "--port", String(port),
  "--disable-terminal-launch",
  "--opencode-db", path.join(temp, "missing-opencode.db"),
  "--claude-dir", path.join(temp, "missing-claude"),
  "--codex-dir", path.join(temp, "missing-codex"),
  "--gemini-dir", path.join(temp, "missing-gemini"),
  "--pi-dir", path.join(temp, "missing-pi")
], { stdio: ["ignore", "pipe", "pipe"] });
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
  const expectedProviderIds = ["opencode", "claude-code", "codex", "gemini", "pi"];
  if (!Array.isArray(providers)
    || JSON.stringify(providers.map((provider) => provider.id)) !== JSON.stringify(expectedProviderIds)) {
    throw new Error("Viewer binary returned an invalid provider list");
  }
  for (const asset of ["style.css", "app.js"]) {
    const response = await fetch(`http://127.0.0.1:${port}/static/${asset}`);
    const body = await response.text();
    if (!response.ok || body.length < 1000) throw new Error(`Embedded ${asset} is unavailable`);
  }
} finally {
  server.kill();
}

const configPath = path.join(temp, "mcp-config.json");
writeFileSync(configPath, JSON.stringify({
  dbPath: path.join(temp, "missing-opencode.db"),
  claudeDir: path.join(temp, "missing-claude"),
  codexDir: path.join(temp, "missing-codex"),
  geminiDir: path.join(temp, "missing-gemini"),
  piDir: path.join(temp, "missing-pi")
}));
const transport = new StdioClientTransport({
  command: mcp,
  args: ["--config", configPath],
  stderr: "pipe"
});
const client = new Client({ name: "agentsession-sea-smoke", version: "1.0.0" });
await client.connect(transport);
try {
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
    arguments: { query: "binary-smoke-no-match" }
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
  internalAnalysisCommands: true,
  mcpTools: 5
}));
