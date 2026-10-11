#!/usr/bin/env node
import { nativeBinary } from '@acetamido/agentsession-native/binary';
import { runNative } from '@acetamido/agentsession-native/launch';

const args = process.argv.slice(2);
const topLevel = args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0]);
let commandIndex = 0;
while (commandIndex < args.length) {
  if (args[commandIndex] === '--config') commandIndex += 2;
  else if (args[commandIndex].startsWith('--config=')) commandIndex += 1;
  else break;
}
const explicitCommand = ['serve', 'mcp', 'migrate-meta', 'help'].includes(args[commandIndex]);
await runNative(nativeBinary(), topLevel || explicitCommand ? args : ['serve', ...args]);
