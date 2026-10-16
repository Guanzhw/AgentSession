import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';

const cleanups = new WeakMap();

// Node's after hooks are FIFO. Fixtures release later-acquired resources first.
export function onCleanup(t, action) {
  let actions = cleanups.get(t);
  if (!actions) {
    actions = [];
    cleanups.set(t, actions);
    t.after(async () => {
      const errors = [];
      for (const cleanup of actions.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  actions.push(action);
}

export async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(prefix);
  onCleanup(t, () => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function temporaryDirectorySync(t, prefix) {
  const directory = mkdtempSync(prefix);
  onCleanup(t, () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
