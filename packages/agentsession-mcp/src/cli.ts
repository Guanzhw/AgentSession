#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initConfig } from "agentsession/config";
import { createSessionHistoryService } from "agentsession/session-history";
import { createSessionHistoryMcpServer } from "./session-history-server.js";

const config = initConfig(process.argv.slice(2));
const service = createSessionHistoryService({ limits: config.mcp });
const diagnostics = await service.refreshIndex();
for (const diagnostic of diagnostics) {
  if (diagnostic.status === "error") {
    console.error(`[agentsession-mcp] ${diagnostic.provider} index failed: ${diagnostic.message || "unknown error"}`);
  }
}

const server = createSessionHistoryMcpServer(service);
await server.connect(new StdioServerTransport());
