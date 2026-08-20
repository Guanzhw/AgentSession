#!/usr/bin/env node

import { initConfig } from "../src/config.js";

async function main() {
  const argv = process.argv.slice(2);
  const config = initConfig(argv);
  const { startServer } = await import("../src/server.js");
  await startServer(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
