#!/usr/bin/env node

import { initConfig } from "../src/config.js";
import { runAnalysisToolCli } from "../src/analysis-tools.js";
import { runAnalysisValidatorCli } from "../src/analysis-validator.js";

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if (mode === "--internal-analysis-tool") {
    runAnalysisToolCli(argv.slice(1));
    return;
  }
  if (mode === "--internal-analysis-validator") {
    runAnalysisValidatorCli(argv.slice(1));
    return;
  }

  const config = initConfig(argv);
  const { startServer } = await import("../src/server.js");
  await startServer(config);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
