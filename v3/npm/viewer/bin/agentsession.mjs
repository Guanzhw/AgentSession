#!/usr/bin/env node
import { nativeBinary } from '@acetamido/agentsession-native/binary';
import { runNative } from '@acetamido/agentsession-native/launch';

const args = process.argv.slice(2);
const topLevel = args.length === 1 && ['--help', '-h', '--version', '-V'].includes(args[0]);
await runNative(nativeBinary(), topLevel ? args : ['serve', ...args]);
