import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

// Fetch rejects several low ports even when a local server is listening.
const firstPort = 20_000;
const lastPortExclusive = 60_000;

export async function listenOnFetchSafePort(server) {
  let lastBindError;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = randomInt(firstPort, lastPortExclusive);
    try {
      await new Promise((resolve, reject) => {
        const onError = error => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return server;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') throw error;
      lastBindError = error;
    }
  }
  throw new Error('Could not bind a Fetch-safe test port between 20000 and 59999 after 64 attempts.',
    { cause: lastBindError });
}

export async function freeFetchSafePort() {
  const server = await listenOnFetchSafePort(createServer());
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
