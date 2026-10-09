#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const format = "agentsession-v3-snapshot/v1";
const planFormat = "agentsession-v3-capture-plan/v1";
const timeoutMs = 120_000;

function safeError(message) {
  const error = new Error(message);
  error.publicSafe = true;
  return error;
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function usage() {
  console.log(`Usage: node scripts/v3-capture-contract.mjs --plan <private-plan.json> --output <ignored-tmp-file.json>
  [--base-url http://127.0.0.1:PORT] [--mcp-command <executable> --mcp-arg <arg> ...]
  [--mcp-era legacy|modern] [--mcp-cwd <absolute-directory>]

The plan contains cases with unique IDs and either:
  {"id":"providers","kind":"http","path":"/api/providers","body":"json"}
  {"id":"tools","kind":"mcp-list-tools"}
  {"id":"search","kind":"mcp-call","name":"session_search","arguments":{"query":"example"}}
  {"id":"timeline-all","kind":"mcp-paginate","name":"session_timeline","arguments":{"session":{"provider":"codex","sessionId":"example"}},"maxPages":100}

HTTP body modes are json, text, bytes, or none. MCP inherits the current environment.
Raw snapshots can contain private session content and must stay under the checkout's ignored tmp/.`);
}

function parseArgs(argv) {
  const options = { mcpArgs: [], mcpEra: "legacy" };
  const values = new Map([
    ["--plan", "plan"], ["--output", "output"], ["--base-url", "baseUrl"],
    ["--mcp-command", "mcpCommand"], ["--mcp-era", "mcpEra"], ["--mcp-cwd", "mcpCwd"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--mcp-arg") {
      if (argv[index + 1] === undefined) throw safeError("--mcp-arg needs a value");
      options.mcpArgs.push(argv[++index]);
      continue;
    }
    const key = values.get(flag);
    if (!key || argv[index + 1] === undefined) throw safeError(`Invalid or incomplete option: ${flag}`);
    options[key] = argv[++index];
  }
  if (!options.plan || !options.output) throw safeError("--plan and --output are required");
  if (!["legacy", "modern"].includes(options.mcpEra)) throw safeError("--mcp-era must be legacy or modern");
  if (options.mcpCwd && (!path.isAbsolute(options.mcpCwd) || !existsSync(options.mcpCwd) || !lstatSync(options.mcpCwd).isDirectory())) {
    throw safeError("--mcp-cwd must be an existing absolute directory");
  }
  return options;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function privateOutputPath(input) {
  const tmp = path.join(repoRoot, "tmp");
  const output = path.resolve(input);
  if (!isInside(tmp, output)) throw safeError("--output must be under this checkout's tmp/ directory");
  mkdirSync(path.dirname(output), { recursive: true });
  const physicalTmp = realpathSync(tmp);
  const physicalParent = realpathSync(path.dirname(output));
  if (!isInside(realpathSync(repoRoot), physicalTmp) ||
      (physicalParent !== physicalTmp && !isInside(physicalTmp, physicalParent))) {
    throw safeError("--output resolves outside this checkout's tmp/ directory");
  }
  if (existsSync(output)) {
    const existing = lstatSync(output);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) {
      throw safeError("--output must be a regular, unlinked file");
    }
    throw safeError("--output already exists; use a new snapshot path");
  }
  execFileSync("git", ["-C", repoRoot, "check-ignore", "--quiet", "--no-index", "--", output]);
  return output;
}

function readPlan(filePath) {
  let plan;
  try {
    plan = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw safeError("Invalid capture plan JSON");
    throw error;
  }
  if (plan?.format !== planFormat || !Array.isArray(plan.cases)) throw safeError("Invalid capture plan format");
  const ids = new Set();
  for (const item of plan.cases) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id)) {
      throw safeError("Capture cases need unique nonempty IDs");
    }
    ids.add(item.id);
    if (item.kind === "http") {
      if (typeof item.path !== "string" || !item.path.startsWith("/") || item.path.startsWith("//") ||
          !["json", "text", "bytes", "none"].includes(item.body)) {
        throw safeError(`Invalid HTTP case: sha256:${fingerprint(item.id)}`);
      }
    } else if (item.kind === "mcp-list-tools") {
      // The result is the complete tools/list response.
    } else if (item.kind === "mcp-call" || item.kind === "mcp-paginate") {
      if (typeof item.name !== "string" || !item.name || !item.arguments ||
          typeof item.arguments !== "object" || Array.isArray(item.arguments) ||
          (item.kind === "mcp-paginate" &&
            (!Number.isInteger(item.maxPages) || item.maxPages < 1 || item.maxPages > 1000 ||
              Object.hasOwn(item.arguments, "cursor")))) {
        throw safeError(`Invalid MCP call case: sha256:${fingerprint(item.id)}`);
      }
    } else {
      throw safeError(`Unsupported case kind: sha256:${fingerprint(item.id)}`);
    }
  }
  return plan;
}

function localBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw safeError("--base-url must be an HTTP loopback origin");
  }
  return url;
}

async function captureHttp(item, baseUrl) {
  const url = new URL(item.path, baseUrl);
  if (url.origin !== baseUrl.origin) throw safeError(`HTTP case leaves loopback origin: sha256:${fingerprint(item.id)}`);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const bytes = Buffer.from(await response.arrayBuffer());
  let body;
  if (item.body === "json") {
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw safeError(`HTTP case sha256:${fingerprint(item.id)} returned invalid JSON (status ${response.status}, ${bytes.length} bytes, body sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 12)})`);
      }
      throw error;
    }
  }
  else if (item.body === "text") body = bytes.toString("utf8");
  else if (item.body === "bytes") body = bytes.toString("base64");
  else body = null;
  return {
    kind: "http",
    status: response.status,
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    contentDisposition: response.headers.get("content-disposition"),
    body
  };
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(safeError(`Case sha256:${fingerprint(label)} timed out`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function captureMcpPages(client, item) {
  const pages = [];
  const seenCursors = new Set();
  let cursor = null;
  for (let index = 0; index < item.maxPages; index += 1) {
    const argumentsWithCursor = cursor === null ? item.arguments : { ...item.arguments, cursor };
    const response = await withTimeout(client.callTool({ name: item.name, arguments: argumentsWithCursor }), item.id);
    const result = response.structuredContent?.result;
    const nextCursor = result?.nextCursor;
    if (response.isError || !result ||
        !(nextCursor === null || (typeof nextCursor === "string" && nextCursor.length > 0)) ||
        result.truncated !== (nextCursor !== null)) {
      throw safeError(`MCP case sha256:${fingerprint(item.id)} returned an invalid page at index ${index}`);
    }
    pages.push(response);
    if (nextCursor === null) return { kind: item.kind, protocolEra: client.getProtocolEra(), pages };
    if (seenCursors.has(nextCursor)) {
      throw safeError(`MCP case sha256:${fingerprint(item.id)} repeated a cursor at index ${index}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw safeError(`MCP case sha256:${fingerprint(item.id)} exceeded maxPages ${item.maxPages}`);
}

async function capture(options, plan) {
  const httpCases = plan.cases.some((item) => item.kind === "http");
  const mcpCases = plan.cases.some((item) => item.kind.startsWith("mcp-"));
  if (httpCases && !options.baseUrl) throw safeError("HTTP cases require --base-url");
  if (mcpCases && !options.mcpCommand) throw safeError("MCP cases require --mcp-command");
  const baseUrl = httpCases ? localBaseUrl(options.baseUrl) : null;
  let client;
  try {
    if (mcpCases) {
      client = new Client(
        { name: "agentsession-v3-contract-capture", version: "1.0.0" },
        options.mcpEra === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : undefined
      );
      const transport = new StdioClientTransport({
        command: options.mcpCommand,
        args: options.mcpArgs,
        env: { ...process.env },
        cwd: options.mcpCwd,
        stderr: "inherit"
      });
      await withTimeout(client.connect(transport), "MCP connect");
    }
    const cases = [];
    for (const item of plan.cases) {
      let result;
      if (item.kind === "http") result = await captureHttp(item, baseUrl);
      else if (item.kind === "mcp-list-tools") {
        result = { kind: item.kind, protocolEra: client.getProtocolEra(), response: await withTimeout(client.listTools(), item.id) };
      } else if (item.kind === "mcp-paginate") {
        result = await captureMcpPages(client, item);
      } else {
        result = {
          kind: item.kind,
          protocolEra: client.getProtocolEra(),
          response: await withTimeout(client.callTool({ name: item.name, arguments: item.arguments }), item.id)
        };
      }
      cases.push({ id: item.id, result });
    }
    return { format, cases };
  } finally {
    if (client) await client.close();
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  const plan = readPlan(options.plan);
  const output = privateOutputPath(options.output);
  const snapshot = await capture(options, plan);
  writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`Captured ${snapshot.cases.length} cases to ${output}`);
} catch (error) {
  const detail = error?.publicSafe === true ? error.message : error instanceof Error ? error.name : "unknown error";
  console.error(`Capture failed: ${detail}`);
  process.exitCode = 1;
}
