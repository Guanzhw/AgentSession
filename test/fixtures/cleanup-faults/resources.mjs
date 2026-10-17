import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { createServer, get } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { onCleanup, temporaryDirectory, temporaryDirectorySync } from '../../helpers/fixture-cleanup.mjs';

const record = event => appendFileSync(process.env.CLEANUP_TRACE, JSON.stringify({ event }) + '\n');

test('pending HTTP work completes before its SQLite database and directory are released', async t => {
  let directory;
  onCleanup(t, () => {
    assert.equal(existsSync(directory), false);
    record('directory-removed');
  });
  directory = await temporaryDirectory(t, path.join(os.tmpdir(), 'cleanup-http-sqlite-'));
  const database = new DatabaseSync(path.join(directory, 'source.db'));
  onCleanup(t, () => { database.close(); record('sqlite-closed'); });
  database.exec('CREATE TABLE value (n INTEGER); INSERT INTO value VALUES (42)');
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const server = createServer((_request, response) => {
    received();
    setTimeout(() => {
      try {
        response.end(String(database.prepare('SELECT n FROM value').get().n));
      } catch (error) {
        response.destroy(error);
      }
    }, 30);
  });
  let responseBody;
  onCleanup(t, async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.equal(await responseBody, '42');
    record('http-drained');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  responseBody = new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}`, { agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    }).on('error', reject);
  });
  await requestReceived;
});

test('a failed cleanup still closes SQLite and reports every cleanup failure', t => {
  temporaryDirectorySync(t, path.join(os.tmpdir(), 'cleanup-failed-hooks-'));
  const database = new DatabaseSync(':memory:');
  onCleanup(t, () => { database.close(); record('sqlite-closed'); });
  onCleanup(t, () => { throw new Error('INJECTED_FIRST_CLEANUP_FAILURE'); });
  onCleanup(t, () => { throw new Error('INJECTED_SECOND_CLEANUP_FAILURE'); });
});
