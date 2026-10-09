import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeTargets } from './targets.mjs';

export function nativeBinary(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  const descriptor = nativeTargets[target];
  if (!descriptor) {
    throw new Error(`AgentSession 3.0 native binary is unavailable for ${target}; supported targets: ${Object.keys(nativeTargets).join(', ')}.`);
  }
  const binary = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', target, descriptor.executable);
  if (!existsSync(binary)) throw new Error(`AgentSession 3.0 native binary is missing for ${target}: ${binary}`);
  return binary;
}
