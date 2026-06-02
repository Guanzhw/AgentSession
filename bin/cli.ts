#!/usr/bin/env node

import { initConfig } from "../src/config.js";

const config = initConfig();

// Dynamic import to ensure config is set before server loads
const { startServer } = await import("../src/server.js");
await startServer(config);
