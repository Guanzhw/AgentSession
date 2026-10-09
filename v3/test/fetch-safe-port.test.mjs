import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { freeFetchSafePort, listenOnFetchSafePort } from './fetch-safe-port.mjs';

test('test port allocator selects a loopback port accepted by Fetch', async () => {
  const port = await freeFetchSafePort();
  assert.ok(port >= 20_000 && port < 60_000);
  const server = createServer((_request, response) => response.end('ready'));
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ready');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('test port allocator retries a candidate rejected with EACCES', async () => {
  const server = new EventEmitter();
  const attempts = [];
  server.listen = (port, host) => {
    attempts.push({ port, host });
    queueMicrotask(() => {
      if (attempts.length === 1) {
        const error = new Error('Access to this port is denied');
        error.code = 'EACCES';
        server.emit('error', error);
      } else {
        server.emit('listening');
      }
    });
  };
  assert.equal(await listenOnFetchSafePort(server), server);
  assert.equal(attempts.length, 2);
  for (const { port, host } of attempts) {
    assert.ok(port >= 20_000 && port < 60_000);
    assert.equal(host, '127.0.0.1');
  }
});

test('test port allocator reports repeated bind denials', async () => {
  const server = new EventEmitter();
  let attempts = 0;
  server.listen = () => {
    attempts += 1;
    queueMicrotask(() => {
      const error = new Error('Access to this port is denied');
      error.code = 'EACCES';
      server.emit('error', error);
    });
  };
  await assert.rejects(listenOnFetchSafePort(server), error => {
    assert.match(error.message, /after 64 attempts/);
    assert.equal(error.cause?.code, 'EACCES');
    return true;
  });
  assert.equal(attempts, 64);
});
