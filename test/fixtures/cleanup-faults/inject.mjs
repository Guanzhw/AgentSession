import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import http from 'node:http';
import Module, { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const fault = process.env.CLEANUP_FAULT;
const record = value => fs.appendFileSync(process.env.CLEANUP_TRACE, JSON.stringify(value) + '\n');
const makeSync = fs.mkdtempSync;
fs.mkdtempSync = function (...args) {
  const directory = makeSync.apply(this, args);
  record({ event: 'directory', directory });
  return directory;
};
const make = promises.mkdtemp;
promises.mkdtemp = async function (...args) {
  const directory = await make.apply(this, args);
  record({ event: 'directory', directory });
  return directory;
};
const close = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function (...args) {
  const result = close.apply(this, args);
  record({ event: 'database-closed' });
  return result;
};

if (fault === 'settings-write') {
  const write = promises.writeFile;
  promises.writeFile = function (file, ...args) {
    if (String(file).includes('agentsession-v3-settings-boundary-') && String(file).endsWith('config.json')) {
      record({ event: 'injected' });
      throw Object.assign(new Error('INJECTED_CONFIG_WRITE_FAILURE'), { code: 'EIO' });
    }
    return write.call(this, file, ...args);
  };
} else if (fault === 'sql-setup') {
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (sql.includes('CREATE TABLE session_v2')) {
      record({ event: 'injected' });
      return exec.call(this, 'INJECTED_SQL_SETUP_FAILURE');
    }
    return exec.call(this, sql);
  };
} else if (fault === 'metadata-assertion') {
  const equal = assert.equal;
  assert.equal = function (actual, expected, ...args) {
    if (expected === 'Original title') {
      record({ event: 'injected' });
      return equal(actual, 'INJECTED_METADATA_ASSERTION_FAILURE', ...args);
    }
    return equal(actual, expected, ...args);
  };
} else if (fault === 'vite-build') {
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vite') return { build: async () => {
      record({ event: 'injected' });
      throw new Error('INJECTED_VITE_BUILD_FAILURE');
    } };
    return load.call(this, name, ...args);
  };
} else if (fault === 'http-create') {
  http.createServer = function () {
    record({ event: 'injected' });
    throw new Error('INJECTED_HTTP_CREATE_FAILURE');
  };
}
syncBuiltinESMExports();
