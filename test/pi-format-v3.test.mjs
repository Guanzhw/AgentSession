import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  activePiEntries,
  extractPiMeta,
  parsePiSession,
  piAssistantUsageRecords,
  piRecordedUsageRecords,
  piRecordsToMessages,
  piUsageToTokens
} from "../dist/src/providers/pi/parser.js";
import { buildPiSessionProtocol, piCompactionEntry } from "../dist/src/providers/pi/protocol.js";

const fixture = (name) => path.join(process.cwd(), "test", "fixtures", name);

test("Pi v3 current format: custom-role messages, recorded retainedTail/fromHook, and full usage scope", () => {
  const records = parsePiSession(fixture("pi-v3-current.jsonl"));
  const meta = extractPiMeta(records, "fallback");
  assert.equal(meta.id, "019f8a00-0000-7000-8000-000000000001");
  assert.equal(meta.parentId, "019f8900-0000-7000-8000-000000000000");
  assert.equal(meta.metadata.version, 3);

  const messages = piRecordsToMessages(records, meta.id);

  // Active branch: branch_summary is on the active path (Pi attaches the
  // summary at the branch point and continues from there); the abandoned
  // asst0001/tool0001 line must stay hidden.
  assert.equal(activePiEntries(records).at(-1).id, "label0001");
  assert.equal(messages.some((m) => m.id === "asst0001"), false);
  assert.equal(messages.some((m) => m.id === "tool0001"), false);

  // v3 custom-role message entries: display:true joins the active view,
  // display:false stays hidden (mirrors custom_message entry semantics).
  // custom0001 lives on the abandoned line and must stay hidden; custom0002
  // is on the active path and is visible.
  const custom = messages.find((m) => m.id === "custom0001");
  assert.equal(custom, undefined, "abandoned custom-role message stays hidden");
  const custom2 = messages.find((m) => m.id === "custom0002");
  assert.equal(custom2.role, "system");
  assert.equal(custom2.content, "do not forget the docs");
  assert.equal(custom2.metadata.customType, "v3-pending-primer");
  assert.equal(custom2.metadata.legacyRole, null);
  assert.equal(messages.some((m) => m.id === "hidden0001"), false);
  assert.equal(messages.some((m) => m.id === "hidden0002"), false);

  // Compaction evidence: retainedTail recorded, summary view kept.
  const compact = messages.find((m) => m.id === "compact1");
  assert.equal(compact.metadata.type, "compaction");
  assert.equal(compact.metadata.retainedTailCount, 2);
  assert.equal(compact.metadata.fromHook, false);

  // Token truth: assistant + nested toolResult + summary usage across ALL
  // recorded entries, matching Pi's own billed session total
  // (getSessionStats/getUsageCostBreakdown). Abandoned-line usage (asst0001 15
  // + tool0001 3) IS included; the retainedTail embedded assistant copy (18)
  // is NOT counted. Active: branch1 usage 7 + asst0002 10 + tool0002 4 +
  // compact1 usage 16 + asst0003 5 = 42; with abandoned: 42 + 15 + 3 = 60.
  assert.equal(meta.tokenCount, 60);
  const usageRecords = piRecordedUsageRecords(records);
  assert.equal(usageRecords.length, 7);
  assert.ok(usageRecords.some((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.usage));
  assert.ok(usageRecords.some((e) => e.type === "compaction" && e.usage));
  assert.ok(usageRecords.some((e) => e.type === "branch_summary" && e.usage));
  // Abandoned/history branch usage is part of Pi's billed session total.
  assert.ok(usageRecords.some((e) => e.id === "asst0001"), "abandoned assistant usage included");
  assert.ok(usageRecords.some((e) => e.id === "tool0001"), "abandoned toolResult usage included");
  // retainedTail embedded messages are never counted as separate entries: the
  // embedded assistant copy (totalTokens 18) is not a record of its own.
  const compactUsage = usageRecords.find((e) => e.id === "compact1");
  assert.equal(compactUsage.usage.totalTokens, 16);
  assert.equal(meta.tokenCount, 60, "retainedTail embedded usage is not double-counted");
  // The narrower assistant-only view stays active-branch-only and excludes
  // summary records, toolResult records, and the abandoned-line assistant
  // (asst0001).
  assert.equal(piAssistantUsageRecords(records).length, 2);
  assert.equal(piAssistantUsageRecords(records).some((e) => e.id === "asst0001"), false);
  assert.deepEqual(piUsageToTokens({ input: 5, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 10 }), {
    input: 5, output: 3, reasoning: 0, total: 10, cache: { read: 2, write: 0 }
  });
});

test("Pi v3 current format: protocol records retainedTail and fromHook evidence without inventing tasks or runs", () => {
  const records = parsePiSession(fixture("pi-v3-current.jsonl"));
  const session = extractPiMeta(records, "fallback");
  const messages = piRecordsToMessages(records, session.id);
  const protocol = buildPiSessionProtocol({ session, records, messages });

  const compactionEvents = protocol.events.filter((e) => e.kind === "context.compaction");
  assert.equal(compactionEvents.length, 2);
  const [compaction] = compactionEvents;
  // First in source order is branch_summary (source index before compaction).
  assert.equal(compaction.provenance.sourceType, "pi.entry:branch_summary");
  assert.equal(compaction.providerData.fromHook, false);
  assert.equal(compaction.providerData.retainedTailCount, null);
  const piCompaction = compactionEvents.find((e) => e.providerData.entryType === "compaction");
  assert.equal(piCompaction.providerData.retainedTailCount, 2);
  assert.equal(piCompaction.compaction.retainedFromEventId, null, "retainedTail is the recorded evidence, no fabricated event id");

  const artifact = protocol.contextArtifacts.find((a) => a.metadata?.entryType === "compaction");
  assert.equal(artifact.metadata.retainedTailCount, 2);
  assert.equal(artifact.metadata.fromHook, false);
  assert.equal(protocol.tasks.length, 0);
  assert.equal(protocol.agentRuns.length, 0);
});

test("Pi legacy v2 hookMessage role stays readable as custom-message view", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-pi-legacy-"));
  try {
    const file = path.join(temp, "legacy.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":2,"id":"019e0001-0000-7000-8000-000000000001","timestamp":"2026-01-05T01:00:00.000Z","cwd":"D:/WorkSpace"}',
      '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-05T01:00:01.000Z","message":{"role":"user","content":"hello","timestamp":1767546001000}}',
      '{"type":"message","id":"h1","parentId":"u1","timestamp":"2026-01-05T01:00:01.500Z","message":{"role":"hookMessage","customType":"legacy-primer","content":[{"type":"text","text":"legacy hook context"}],"display":true,"details":{"from":"v2"},"timestamp":1767546001500}}',
      '{"type":"message","id":"h2","parentId":"h1","timestamp":"2026-01-05T01:00:01.600Z","message":{"role":"hookMessage","customType":"legacy-hidden","content":[{"type":"text","text":"legacy hidden"}],"display":false,"details":null,"timestamp":1767546001600}}',
      '{"type":"message","id":"a1","parentId":"h2","timestamp":"2026-01-05T01:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"provider":"deepseek","model":"m","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2},"stopReason":"stop","timestamp":1767546002000}}'
    ].join("\n"));
    const records = parsePiSession(file);
    const messages = piRecordsToMessages(records, "019e0001-0000-7000-8000-000000000001");
    const legacy = messages.find((m) => m.id === "h1");
    assert.equal(legacy.role, "system");
    assert.equal(legacy.content, "legacy hook context");
    assert.equal(legacy.metadata.customType, "legacy-primer");
    assert.equal(legacy.metadata.legacyRole, "hookMessage");
    assert.equal(messages.some((m) => m.id === "h2"), false, "display:false hookMessage stays hidden");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Pi malformed session lines throw with line context", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "agentsession-pi-malformed-"));
  try {
    const file = path.join(temp, "bad.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"019e0002-0000-7000-8000-000000000001","timestamp":"2026-01-05T01:00:00.000Z"}',
      "not-json{"
    ].join("\n"));
    assert.throws(() => parsePiSession(file), (error) => {
      assert.match(error.message, /Malformed Pi session line 2/);
      return true;
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
