#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initConfig } from "@acetamido/agentsession/config";
import { createSessionHistoryService } from "@acetamido/agentsession/session-history";
import { parseInstallerCommand, printInstallerHelp, runInstallerCommand } from "./installer.js";
import { createSessionHistoryMcpServer } from "./session-history-server.js";

function printHelp() {
  console.log(`AgentSession-MCP — Read-only Local Session History MCP Server

Usage:
  agentsession-mcp [options]
  agentsession-mcp install [installer options]
  agentsession-mcp update [installer options]

Options:
  --config <path>  Path to an AgentSession JSON config file
  -h, --help       Show this help

Run \`agentsession-mcp install --help\` to install the MCP interactively into
Codex, Claude Code, Gemini CLI, or OpenCode with automatic npm updates.`);
}

const argv = process.argv.slice(2);
const installerAction = argv[0];
if (installerAction === "install" || installerAction === "update") {
  if (argv.includes("--help") || argv.includes("-h")) {
    printInstallerHelp();
    process.exit(0);
  }
  try {
    const installerCommand = parseInstallerCommand(argv);
    if (!installerCommand) {
      printInstallerHelp();
      process.exit(0);
    }
    await runInstallerCommand(installerCommand.action, installerCommand.options);
    process.exit(0);
  } catch (error) {
    console.error(`[agentsession-mcp] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const config = initConfig(argv);
const service = createSessionHistoryService({ limits: config.mcp });
const diagnostics = await service.refreshIndex();
for (const diagnostic of diagnostics) {
  if (diagnostic.status === "error") {
    console.error(`[agentsession-mcp] ${diagnostic.provider} index failed: ${diagnostic.message || "unknown error"}`);
  }
}

const server = createSessionHistoryMcpServer(service);
await server.connect(new StdioServerTransport());
