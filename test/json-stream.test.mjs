import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { json } from "../dist/src/server-helpers.js";
import { jsonChunks, streamJson } from "../dist/src/json-stream.js";

function response({ mode = "normal" } = {}) {
  const result = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      this.body += chunk.toString("utf8");
      if (mode === "disconnect") {
        setImmediate(() => this.destroy());
      }
      setImmediate(callback);
    }
  });
  Object.assign(result, {
    statusCode: 0,
    headers: {},
    headersSent: false,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    destroy(error) {
      this.destroyError = error;
      Writable.prototype.destroy.call(this, error);
    }
  });
  result.on("error", () => {});
  return result;
}

test("json stream matches JSON.stringify semantics for normalized payload values", () => {
  const repeated = { nested: "工具🙂", raw: '{"provider":"codex"}' };
  const value = {
    unicode: "line\n🙂\ud800",
    omitted: undefined,
    nonFinite: [NaN, Infinity, -Infinity, -0, undefined],
    first: repeated,
    second: repeated,
    providerToolJson: { input: '{"path":"src\\\\file.ts"}', output: "raw provider output" }
  };
  const expected = JSON.stringify(value);
  const chunks = [...jsonChunks(value, 128)];
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 128));
  assert.equal(chunks.join(""), expected);
  assert.equal([...jsonChunks(value, 128, 2)].join(""), JSON.stringify(value, null, 2));

  const crossBoundary = `{"text":${JSON.stringify(`${"a".repeat(118)}🙂tail`)}}`;
  const crossChunks = [...jsonChunks({ text: `${"a".repeat(118)}🙂tail` }, 128)];
  assert.equal(Buffer.concat(crossChunks.map((chunk) => Buffer.from(chunk))).toString("utf8"), crossBoundary);
  const sourceBoundary = `${"a".repeat(127)}🙂tail`;
  assert.equal(
    Buffer.concat([...jsonChunks(sourceBoundary, 128)].map((chunk) => Buffer.from(chunk))).toString("utf8"),
    JSON.stringify(sourceBoundary)
  );
  assert.equal(
    [...jsonChunks({ tree: { inferredChildSessionIds: new Set(["child"]) } })].join(""),
    JSON.stringify({ tree: { inferredChildSessionIds: new Set(["child"]) } })
  );
});

test("streamJson honors backpressure and stops on a disconnected client", async () => {
  let writes = 0;
  const backpressured = response();
  const originalWrite = backpressured._write;
  backpressured._write = function (chunk, encoding, callback) {
    writes += 1;
    originalWrite.call(this, chunk, encoding, callback);
  };
  const closeListeners = backpressured.listenerCount("close");
  const errorListeners = backpressured.listenerCount("error");
  assert.equal(await streamJson(backpressured, { text: "x".repeat(300) }, 200, {}, 128), true);
  assert.equal(backpressured.writableEnded, true);
  assert.ok(writes > 1);
  assert.deepEqual(JSON.parse(backpressured.body), { text: "x".repeat(300) });
  assert.equal(backpressured.listenerCount("close"), closeListeners);
  assert.equal(backpressured.listenerCount("error"), errorListeners);

  let disconnectedWrites = 0;
  const disconnected = response({ mode: "disconnect" });
  const disconnectWrite = disconnected._write;
  disconnected._write = function (chunk, encoding, callback) {
    disconnectedWrites += 1;
    disconnectWrite.call(this, chunk, encoding, callback);
  };
  assert.equal(await streamJson(disconnected, { text: "y".repeat(300) }, 200, {}, 128), false);
  assert.equal(disconnected.writableEnded, false);
  assert.equal(disconnectedWrites, 1);
});

test("streamJson terminates a started response when serialization fails", async () => {
  const circular = {};
  circular.self = circular;
  const target = response();
  await assert.rejects(() => streamJson(target, circular), /circular structure/i);
  assert.equal(target.destroyed, true);
  assert.match(target.destroyError?.message || "", /circular structure/i);
  assert.equal(target.writableEnded, false);
});

test("json serializes before sending headers when JSON.stringify rejects", () => {
  const target = response();
  assert.throws(() => json(target, { unsupported: 1n }), /BigInt/);
  assert.equal(target.headersSent, false);
});
