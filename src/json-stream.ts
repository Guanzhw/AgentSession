import type { ServerResponse } from "node:http";

const DEFAULT_CHUNK_SIZE = 16 * 1024;

function* escapedString(value: string, chunkSize: number): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + chunkSize);
    if (end < value.length) {
      const last = value.charCodeAt(end - 1);
      const next = value.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    if (end === start) end += 1;
    const encoded = JSON.stringify(value.slice(start, end));
    yield encoded.slice(1, -1);
    start = end;
  }
  yield '"';
}

function* jsonTokens(
  value: any,
  ancestors: Set<object>,
  chunkSize: number,
  space: string,
  depth: number
): Generator<string> {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return;
  if (value === null) {
    yield "null";
    return;
  }
  if (typeof value === "string") {
    yield* escapedString(value, chunkSize);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? JSON.stringify(value) : "null";
    return;
  }
  if (typeof value === "boolean") {
    yield value ? "true" : "false";
    return;
  }
  if (typeof value === "bigint") {
    // Match JSON.stringify's explicit failure for BigInt values.
    throw new TypeError("Do not know how to serialize a BigInt");
  }

  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        yield "[]";
        return;
      }
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index) yield ",";
        if (space) yield `\n${space.repeat(depth + 1)}`;
        const itemValue = value[index];
        if (itemValue === undefined || typeof itemValue === "function" || typeof itemValue === "symbol") {
          yield "null";
        } else {
          yield* jsonTokens(itemValue, ancestors, chunkSize, space, depth + 1);
        }
      }
      if (space) yield `\n${space.repeat(depth)}`;
      yield "]";
      return;
    }

    const entries: Array<[string, any]> = [];
    for (const property of Object.keys(value)) {
      const propertyValue = value[property];
      if (propertyValue === undefined || typeof propertyValue === "function" || typeof propertyValue === "symbol") continue;
      entries.push([property, propertyValue]);
    }
    if (entries.length === 0) {
      yield "{}";
      return;
    }
    yield "{";
    for (let index = 0; index < entries.length; index += 1) {
      if (index) yield ",";
      if (space) yield `\n${space.repeat(depth + 1)}`;
      const [property, propertyValue] = entries[index];
      yield* escapedString(property, chunkSize);
      yield space ? ": " : ":";
      yield* jsonTokens(propertyValue, ancestors, chunkSize, space, depth + 1);
    }
    if (space) yield `\n${space.repeat(depth)}`;
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

export function* jsonChunks(value: any, chunkSize = DEFAULT_CHUNK_SIZE, indentation = 0): Generator<string> {
  const size = chunkSize;
  const space = " ".repeat(indentation);
  let chunk = "";
  for (const token of jsonTokens(value, new Set(), size, space, 0)) {
    if (!token) continue;
    chunk += token;
    while (chunk.length >= size) {
      let end = size;
      if (end < chunk.length) {
        const last = chunk.charCodeAt(end - 1);
        const next = chunk.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
      }
      yield chunk.slice(0, end);
      chunk = chunk.slice(end);
    }
  }
  if (chunk) yield chunk;
}

function waitForWritable(res: ServerResponse): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = () => finish(false);
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
      res.removeListener("error", onError);
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

export async function streamJson(
  res: ServerResponse,
  value: any,
  status = 200,
  headers: Record<string, string> = {},
  chunkSize = DEFAULT_CHUNK_SIZE,
  indentation = 0
): Promise<boolean> {
  let started = false;
  try {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    started = true;
    for (const chunk of jsonChunks(value, chunkSize, indentation)) {
      if (res.destroyed || res.writableEnded) return false;
      if (!res.write(chunk)) {
        if (!(await waitForWritable(res))) return false;
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end();
    return true;
  } catch (error) {
    if (started || res.headersSent) {
      if (!res.writableEnded) {
        const reason = error instanceof Error ? error : new Error(String(error));
        res.destroy(reason);
      }
      throw error;
    }
    throw error;
  }
}
