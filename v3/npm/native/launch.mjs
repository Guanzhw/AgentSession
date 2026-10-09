import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export async function runNative(binary, args) {
  const child = spawn(binary, args, { stdio: 'inherit', windowsHide: true });
  const forward = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = result.signal
      ? 128 + (constants.signals[result.signal] ?? 1)
      : result.code ?? 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}
