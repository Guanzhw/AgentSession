import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionFileStore } from "../dist/src/providers/shared/file-adapter-helpers.js";

function fixture(t, options = {}) {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-payload-cache-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const descriptors = ["a", "b", "c"].map((name) => ({ sessionId: `alias-${name}`, filePath: path.join(temp, `${name}.json`) }));
  const reads = new Map();
  const failures = new Set();
  const errors = [];
  const write = (name, value) => writeFileSync(path.join(temp, `${name}.json`), JSON.stringify(value));
  for (const name of ["a", "b", "c"]) write(name, { id: `canonical-${name}`, parentId: name === "a" ? null : "canonical-a", text: `body-${name}` });
  const store = createSessionFileStore({
    discoverFiles: () => descriptors,
    maxCachedSourceBytes: 1,
    refreshIntervalMs: 0,
    readEntry({ filePath, dependencyPaths = [] }) {
      reads.set(filePath, (reads.get(filePath) || 0) + 1);
      if (failures.has(filePath)) throw new Error("body unavailable");
      const source = JSON.parse(readFileSync(filePath, "utf8"));
      const dependency = dependencyPaths.map((file) => readFileSync(file, "utf8")).join("");
      return {
        session: { id: source.id, parentId: source.parentId, title: source.text + dependency },
        records: [source],
        messages: [{ id: "message", content: source.text + dependency }]
      };
    },
    onError(filePath, error) { errors.push({ filePath, error }); },
    ...options
  });
  return { temp, descriptors, store, reads, failures, errors, write };
}

test("bounded payload eviction preserves canonical metadata, aliases, families and complete rereads", (t) => {
  const { store, descriptors, reads } = fixture(t);
  assert.deepEqual(store.list().map((entry) => entry.session.id), ["canonical-a", "canonical-b", "canonical-c"]);
  assert.deepEqual(store.getFamily("alias-a").map((entry) => entry.session.id), ["canonical-a", "canonical-b", "canonical-c"]);
  assert.equal(store.getFileSignatures().length, 3);
  assert.equal(reads.get(descriptors[0].filePath), 1, "metadata and relationship lookups do not reparse evicted bodies");

  const entry = store.get("alias-a");
  const records = entry.records;
  const messages = entry.messages;
  assert.equal(reads.get(descriptors[0].filePath), 2);
  assert.equal(entry.records, records, "one oversized body stays cached whole");
  assert.equal(entry.messages, messages);
  assert.equal(store.get("canonical-b").records[0].text, "body-b");
  assert.notEqual(entry.records, records, "an evicted body is read again");
  assert.deepEqual(entry.records, records);
  assert.deepEqual(entry.messages, messages);
  assert.equal(reads.get(descriptors[0].filePath), 3);
});

test("bounded payload refresh invalidates content, canonical ids and dependency signatures", (t) => {
  const { temp, store, descriptors, reads, write } = fixture(t);
  const dependency = path.join(temp, "extra.txt");
  writeFileSync(dependency, "first");
  descriptors[0].dependencyPaths = [dependency];
  store.refresh();
  const firstSignature = store.getFileSignatures()[0].signature;
  const firstRevision = store.getStatsRevision();
  write("a", { id: "renamed-a", parentId: null, text: "replacement body" });
  const changed = store.get("alias-a");
  assert.equal(changed.session.id, "renamed-a");
  assert.equal(changed.messages[0].content, "replacement bodyfirst");
  assert.equal(store.get("canonical-a"), null);
  assert.ok(store.getStatsRevision() > firstRevision);
  assert.notEqual(store.getFileSignatures()[0].signature, firstSignature);
  const before = reads.get(descriptors[0].filePath);
  writeFileSync(dependency, "updated dependency");
  assert.equal(store.get("renamed-a").messages[0].content, "replacement bodyupdated dependency");
  assert.equal(reads.get(descriptors[0].filePath), before + 1);
});

test("bounded payload reads retain the most recently used body within the source budget", (t) => {
  const { store, descriptors, reads } = fixture(t, { maxCachedSourceBytes: 150 });
  store.refresh();
  store.get("canonical-a").records;
  const retained = store.get("canonical-c").messages;
  store.get("canonical-b").records;
  assert.equal(store.get("canonical-c").messages, retained);
  assert.equal(reads.get(descriptors[2].filePath), 1);
  store.get("canonical-a").records;
  assert.equal(reads.get(descriptors[0].filePath), 3);
});

test("evicted bodies refresh coherent metadata, identities, signatures and weights inside the refresh interval", (t) => {
  const { store, descriptors, reads, write } = fixture(t, { maxCachedSourceBytes: 150, refreshIntervalMs: 60000 });
  const oldEntry = store.get("alias-a");
  const oldSignature = store.getFileSignatures()[0].signature;
  write("a", { id: "renamed-a", parentId: null, text: "larger replacement ".repeat(30) });
  assert.throws(() => oldEntry.records, /transcript changed/);

  const current = store.get("alias-a");
  assert.equal(current.session.id, "renamed-a");
  assert.equal(current.records[0].id, current.session.id);
  assert.equal(current.messages[0].content, current.session.title);
  assert.equal(store.get("canonical-a"), null);
  assert.notEqual(store.getFileSignatures()[0].signature, oldSignature);
  assert.throws(() => oldEntry.messages, /transcript changed/);
  const before = reads.get(descriptors[0].filePath);
  store.get("canonical-c").records;
  current.records;
  assert.equal(reads.get(descriptors[0].filePath), before + 1, "the grown source has its new oversized cache weight");
});

test("old entry handles never pair stale metadata with a replacement payload after refresh", (t) => {
  const { store, write } = fixture(t);
  const oldEntry = store.get("canonical-a");
  assert.equal(oldEntry.records[0].text, "body-a");
  write("a", { id: "canonical-a", parentId: null, text: "changed source body" });
  store.refresh(true);
  const current = store.get("canonical-a");
  assert.equal(current.session.title, "changed source body");
  assert.equal(current.records[0].text, current.session.title);
  assert.equal(oldEntry.session.title, "body-a");
  assert.throws(() => oldEntry.records, /transcript changed/);
  assert.throws(() => oldEntry.messages, /transcript changed/);
});

test("evicted bodies also refresh changed dependency metadata inside the refresh interval", (t) => {
  const { temp, store, descriptors } = fixture(t, { refreshIntervalMs: 60000 });
  const dependency = path.join(temp, "extra.txt");
  writeFileSync(dependency, "first");
  descriptors[0].dependencyPaths = [dependency];
  const oldEntry = store.get("canonical-a");
  writeFileSync(dependency, "new dependency");
  const current = store.getByFilePath(descriptors[0].filePath);
  assert.equal(current.session.title, "body-anew dependency");
  assert.equal(current.messages[0].content, current.session.title);
  assert.throws(() => oldEntry.records, /transcript changed/);
});

test("a source changing during lazy parsing is rejected before its payload is cached", (t) => {
  let mutateDuringRead = false;
  const { store } = fixture(t, {
    refreshIntervalMs: 60000,
    readEntry({ filePath }) {
      const record = JSON.parse(readFileSync(filePath, "utf8"));
      if (mutateDuringRead) {
        mutateDuringRead = false;
        writeFileSync(filePath, JSON.stringify({ ...record, text: "changed during parse" }));
      }
      return { session: { id: record.id, title: record.text }, records: [record], messages: [record.text] };
    }
  });
  const entry = store.get("canonical-a");
  mutateDuringRead = true;
  assert.throws(() => entry.records, /transcript changed/);
  const current = store.get("canonical-a");
  assert.equal(current.session.title, "changed during parse");
  assert.equal(current.messages[0], current.session.title);
});

test("bounded cache propagates failed lazy reads and retains stale bodies only while available", (t) => {
  const { store, descriptors, failures, errors, write } = fixture(t);
  store.refresh();
  failures.add(descriptors[0].filePath);
  assert.throws(() => store.get("canonical-a").records, /body unavailable/);
  failures.clear();
  const retained = store.get("canonical-a").records;
  failures.add(descriptors[0].filePath);
  write("a", { id: "canonical-a", text: "changed but currently unreadable" });
  store.refresh();
  assert.equal(store.get("canonical-a").records, retained);
  assert.ok(errors.length >= 1);
  store.get("canonical-b").records;
  store.refresh();
  assert.equal(store.get("canonical-a"), null, "an evicted stale body cannot be fabricated after refresh failure");
});

test("unbounded providers keep their existing payload identity across metadata refreshes", (t) => {
  const { store, descriptors, reads } = fixture(t, { maxCachedSourceBytes: undefined });
  const entries = store.list();
  const records = entries[0].records;
  store.get("canonical-b").records;
  store.get("canonical-c").records;
  store.refresh();
  assert.equal(store.get("canonical-a").records, records);
  assert.equal(reads.get(descriptors[0].filePath), 1);
});
