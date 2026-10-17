import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

function isExecutable(candidate) {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
}

// Only the public browser suites opt into this gate; private corpora retain
// their own availability rules. Local runs may skip when tooling is absent.
export function browserPrerequisites({ ui, env = process.env } = {}) {
  const binaryName = process.platform === 'win32' ? 'agent-browser-win32-x64.exe'
    : `agent-browser-${process.platform}-${process.arch}`;
  const candidates = env.AGENTSESSION_V3_AGENT_BROWSER_BIN
    ? [env.AGENTSESSION_V3_AGENT_BROWSER_BIN]
    : (env.PATH || '').split(path.delimiter).filter(Boolean)
      .map(entry => path.join(entry, 'node_modules', 'agent-browser', 'bin', binaryName));
  const browserBinary = candidates.find(isExecutable);
  const skip = ui && ['vite', 'svelte'].some(dependency => !existsSync(path.join(ui, 'node_modules', dependency)))
    ? 'Install the locked v3/ui dependencies before running browser tests.'
    : !browserBinary ? 'An executable agent-browser native binary is required for browser tests.'
      : env.AGENT_BROWSER_EXECUTABLE_PATH && !isExecutable(env.AGENT_BROWSER_EXECUTABLE_PATH)
        ? 'The explicitly selected Chrome executable is unavailable or not executable.' : false;
  if (skip && env.AGENTSESSION_V3_REQUIRE_BROWSER === '1') {
    throw new Error(`AGENTSESSION_V3_REQUIRE_BROWSER=1: ${skip}`);
  }
  return { browserBinary: browserBinary ? path.resolve(browserBinary) : undefined, skip };
}
