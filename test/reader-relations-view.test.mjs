import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionReaderPane, renderReaderProcessChunk } from "../dist/src/views/session.js";
import { buildMessageSessionTree } from "../dist/src/providers/shared/message-session.js";
import { buildPartsFromProviderMessages } from "../dist/src/session-queries.js";
import { renderProgressiveContent, resolveProgressiveField } from "../dist/src/views/components.js";
import { renderReaderRelations, readerRelationPositionKey } from "../dist/src/views/reader-relations.js";

const messages = [
  { id: "u", sessionId: "root", role: "user", content: "Please implement", timestamp: 1 },
  { id: "a1", sessionId: "root", role: "assistant", content: "Working on it", thinking: "Recorded reasoning", timestamp: 2, metadata: { turnId: "turn-a", presentationPhase: "commentary" } },
  { id: "dispatch", sessionId: "root", role: "tool", toolName: "spawn", toolInput: { task: "A" }, toolOutput: "child", timestamp: 3 },
  { id: "a2", sessionId: "root", role: "assistant", content: "Work continues after first return", timestamp: 5, metadata: { turnId: "turn-a" } },
  { id: "done", sessionId: "root", role: "assistant", content: "Final answer", timestamp: 8, metadata: { presentationPhase: "final" } }
];
const session = { id: "root", title: "Inline runtime fixture" };
const lane = { id: "fixture:child", name: "Worker <A>", childSession: { provider: "fixture", sessionId: "child/a" }, runIds: ["run-a"] };
const milestone = (id, sequence, kind, partId, side = "after") => ({
  id, laneId: lane.id, kind, eventId: id, sequence, timestamp: sequence * 1000, runId: "run-a",
  sourceEventRef: { session: { provider: "fixture", sessionId: "root" }, eventId: id },
  position: { messageId: partId.split(":")[0], partId, side }
});
const relations = { lanes: [lane], unplaced: [], milestones: [
  milestone("dispatch-event", 3, "spawn", "dispatch:tool", "before"),
  milestone("returned-1", 4, "result-delivery", "a2:text", "before"),
  milestone("followup", 6, "follow-up", "a2:text"),
  milestone("returned-2", 7, "result-delivery", "done:text", "before")
] };
const input = () => ({ session, provider: "fixture", readerRelations: relations, sessionTree: buildMessageSessionTree(session, messages) });

test("inline markers retain exact part order within grouped history and canonical task navigation", () => {
  const model = input();
  const pane = renderSessionReaderPane(model);
  const html = pane.slice(pane.indexOf('<section id="session-messages"'));
  const ordered = ["id=\"milestone-dispatch-event\"", "id=\"part-dispatch-tool\"", "id=\"milestone-returned-1\"", "Work continues after first return", "id=\"milestone-followup\"", "id=\"milestone-returned-2\"", "Final answer"];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(html.indexOf(ordered[index - 1]) >= 0, ordered[index - 1]);
    assert.ok(html.indexOf(ordered[index - 1]) < html.indexOf(ordered[index]), `${ordered[index - 1]} precedes ${ordered[index]}`);
  }
  assert.equal((html.match(/data-reader-milestone /g) || []).length, 4);
  assert.match(html, /Worker &lt;A&gt;/);
  assert.match(html, /href="\/fixture\/session\/child%2Fa"/);
  assert.match(html, /readerEvent=returned-1/);
  assert.match(html, /data-progressive-part-id="a1:reasoning" data-progressive-field="reasoning"/);
  assert.ok(html.indexOf('id="part-a1-reasoning"') < html.indexOf('id="milestone-dispatch-event"'));
  const reasoning = model.sessionTree.messages.flatMap((message) => message.parts).find((part) => part.id === "a1:reasoning");
  const field = resolveProgressiveField(reasoning.data, "reasoning");
  assert.match(renderProgressiveContent(field.value, field.format, 0, field.limit).html, /Recorded reasoning/);
  assert.match(html, /data-reader-relations/);
  assert.match(html, /reader-collaboration-insert/);
  assert.match(html, /data-reader-relations-controls/);
  assert.match(html, /reader-milestone-mark-in/);
});

test("milestones remain visible while source tools and reasoning are independently folded", () => {
  const html = renderSessionReaderPane(input());
  const marker = html.indexOf('id="milestone-dispatch-event"');
  const groupStart = html.lastIndexOf('<article ', marker);
  const outerFold = html.lastIndexOf('data-conversation-process ', groupStart);
  assert.ok(outerFold < 0 || html.indexOf('</details>', outerFold) < groupStart);
  assert.match(html, /<details[^>]*class="[^"]*(tool|reasoning)/);
  assert.doesNotMatch(html, /<details[^>]*(tool|reasoning)[^>]*\sopen(?:\s|>)/);
  assert.match(html.slice(marker), /data-reader-execution[\s\S]*id="part-dispatch-tool"/);
});

test("adjacent tool calls share a closed process disclosure without consuming prose", () => {
  const tree = buildMessageSessionTree(session, [
    { id: 'text', sessionId: 'root', role: 'assistant', content: 'Readable answer', timestamp: 1 },
    { id: 'one', sessionId: 'root', role: 'tool', toolName: 'exec', toolOutput: 'First output', timestamp: 2 },
    { id: 'two', sessionId: 'root', role: 'tool', toolName: 'exec', toolOutput: 'Second output', timestamp: 3 }
  ]);
  const html = renderSessionReaderPane({ session, sessionTree: tree, provider: 'fixture' });
  const process = html.indexOf('data-reader-execution');
  assert.ok(html.indexOf('Readable answer') < process);
  assert.match(html, /data-reader-execution-count="2"/);
  assert.match(html.slice(process), /id="part-one-tool"[^>]*data-reader-process-anchor[\s\S]*id="part-two-tool"[^>]*data-reader-process-anchor/);
  const fragment = renderReaderProcessChunk({ sessionTree: tree, messageId: tree.messages[0].id, firstPartId: 'one:tool', lastPartId: 'two:tool' });
  assert.equal(fragment.count, 2);
  assert.match(fragment.html, /data-progressive-part-id="one:tool" data-progressive-field="output"[\s\S]*data-progressive-part-id="two:tool" data-progressive-field="output"/);
  assert.doesNotMatch(html, /First output|Second output/);
  const parts = tree.messages.flatMap((message) => message.parts);
  for (const [partId, expected] of [['one:tool', 'First output'], ['two:tool', 'Second output']]) {
    const field = resolveProgressiveField(parts.find((part) => part.id === partId).data, "output");
    const page = renderProgressiveContent(field.value, field.format, 0, field.limit);
    assert.ok(page.html.includes(expected));
    assert.equal(page.nextOffset, null);
  }
  assert.doesNotMatch(html, /<details[^>]*data-reader-execution[^>]*\sopen(?:\s|>)/);
});

test("raw-message reader uses the same milestones without a SessionTree", () => {
  const document = buildPartsFromProviderMessages(messages);
  const html = renderSessionReaderPane({ session, provider: "fixture", ...document, readerRelations: relations });
  assert.equal((html.match(/data-reader-milestone /g) || []).length, 4);
  assert.ok(html.indexOf('id="milestone-returned-1"') < html.indexOf('Work continues after first return'));
  assert.match(html, /Final answer/);
});

test("unplaced recorded observations keep an explicit source disclosure", () => {
  const html = renderSessionReaderPane({ ...input(), readerRelations: {
    lanes: [], milestones: [], unplaced: [{
      id: "unplaced-observation", laneId: null, kind: "child-turn-completed", eventId: "event-unplaced",
      sequence: null, timestamp: null, runId: null,
      sourceEventRef: { session: { provider: "fixture", sessionId: "other" }, eventId: "event-unplaced" },
      reason: "external_source"
    }]
  } });
  assert.match(html, /reader-relations-unplaced/);
  assert.match(html, /data-reader-relation-unplaced/);
  assert.match(html, /href="\/fixture\/session\/other\?readerEvent=event-unplaced"/);
  assert.match(html, /data-reader-relations-controls/);
});

test("history with no located relationships keeps the full ordinary reading surface", () => {
  const html = renderSessionReaderPane({ ...input(), readerRelations: { lanes: [], milestones: [], unplaced: [] } });
  assert.doesNotMatch(html, /data-reader-relations|data-reader-relation-canvas/);
  for (const text of ["Please implement", "Working on it", "Final answer"]) assert.ok(html.includes(text));
});

test("inline step links connect key observations of the canonical task in source order", () => {
  const other = { ...lane, id: "fixture:other", childSession: { provider: "fixture", sessionId: "other" } };
  const value = { ...relations, lanes: [lane, other], milestones: [
    relations.milestones[0],
    { ...milestone("ordinary", 3.5, "message", "dispatch:tool"), timestamp: null },
    { ...milestone("different-task", 3.8, "spawn", "dispatch:tool"), laneId: other.id },
    { ...relations.milestones[1], timestamp: 1 },
    { ...relations.milestones[2], timestamp: null },
    relations.milestones[3]
  ] };
  const source = JSON.stringify(value);
  const rendered = renderReaderRelations(value);
  const at = (item) => rendered.parts.get(readerRelationPositionKey(item.position.partId, item.position.side));
  const dispatch = at(value.milestones[0]);
  assert.match(dispatch, /reader-step-next[^>]*data-reader-anchor="milestone-returned-1"/);
  assert.match(dispatch, /href="\/fixture\/session\/root#milestone-returned-1"/);
  assert.doesNotMatch(dispatch, /reader-step-previous|data-reader-anchor="milestone-(ordinary|different-task)"/);
  const returned = at(value.milestones[3]);
  assert.match(returned, /reader-step-previous[^>]*data-reader-anchor="milestone-dispatch-event"/);
  assert.match(returned, /reader-step-next[^>]*data-reader-anchor="milestone-followup"/);
  const final = at(value.milestones[5]);
  assert.match(final, /reader-step-previous[^>]*data-reader-anchor="milestone-followup"/);
  assert.doesNotMatch(final, /reader-step-next/);
  assert.equal(JSON.stringify(value), source);
});

test("only wholly ordinary positions are marked for process folding", () => {
  const ordinary = milestone("ordinary", 10, "message", "ordinary:tool");
  const mixed = milestone("mixed-message", 11, "message", "mixed:tool");
  const key = milestone("mixed-return", 12, "result-delivery", "mixed:tool");
  const value = renderReaderRelations({ lanes: [lane], unplaced: [], milestones: [ordinary, mixed, key] });
  assert.deepEqual([...value.processPositions], [readerRelationPositionKey("ordinary:tool", "after")]);
  assert.match(value.parts.get(readerRelationPositionKey("ordinary:tool", "after")), /id="milestone-ordinary"/);
});

test("Team peer handoffs and root follow-ups are visible, expandable reading nodes", () => {
  const peer = {
    ...milestone("peer-handoff", 13, "message", "peer:tool"),
    position: { messageId: "peer", partId: "peer:tool", side: "before", withinExecution: true },
    state: "delivered", turnId: "turn-peer", senderActorId: "writer", senderName: "Writer",
    recipientActorId: "reviewer", recipientName: "Reviewer", teamPeerMessage: true, messageAction: "handoff"
  };
  const rootFollowup = {
    ...milestone("root-followup", 14, "message", "root:tool"),
    state: "unknown", turnId: "turn-root", senderActorId: "root", senderName: "Root",
    recipientActorId: "writer", recipientName: "Writer", teamPeerMessage: false, messageAction: "follow-up"
  };
  const value = renderReaderRelations({ lanes: [{ ...lane, purpose: "Inspect the patch" }], unplaced: [], milestones: [peer, rootFollowup] });
  const peerMarkup = value.parts.get(readerRelationPositionKey("peer:tool", "before"));
  assert.match(peerMarkup, /Writer → Reviewer/);
  assert.match(peerMarkup, /Inspect the patch/);
  assert.match(peerMarkup, /data-reader-coordination-content/);
  assert.match(peerMarkup, /data-reader-coordination-content-url="\/api\/fixture\/session\/root\/reader\/coordination\/peer-handoff\/content"/);
  assert.match(peerMarkup, /reader-coordination-technical/);
  assert.match(peerMarkup, /data-reader-open[^>]*data-reader-session="child\/a"/);
  assert.ok(value.placedObservationIds.has("peer-handoff"));
  assert.ok(value.placedObservationIds.has("root-followup"));
  assert.deepEqual([...value.processPositions], []);
  const rootMarkup = value.parts.get(readerRelationPositionKey("root:tool", "after"));
  assert.match(rootMarkup, /Additional instructions/);
  assert.match(peerMarkup, /Handoff/);
  assert.match(peerMarkup, /During this execution/);
  assert.doesNotMatch(peerMarkup, /reader-milestone-main/);
  assert.doesNotMatch(peerMarkup, /data-reader-lane-focus/);
  assert.match(peerMarkup, /<\/details><div class="reader-coordination-content-actions"><a[^>]*data-reader-open/);
});

test("many observations at one source position expand locally with complete anchors and step links", () => {
  const milestones = Array.from({ length: 60 }, (_, index) => milestone(`batch-${index}`, index + 1, "spawn", "dispatch:tool"));
  const value = renderReaderRelations({ lanes: [lane], unplaced: [], milestones });
  const html = value.parts.get(readerRelationPositionKey("dispatch:tool", "after"));
  const overflow = html.indexOf('<details class="reader-collaboration-overflow">');
  assert.ok(overflow > 0);
  assert.equal((html.slice(0, overflow).match(/data-reader-milestone /g) || []).length, 3);
  assert.equal((html.slice(overflow).match(/data-reader-milestone /g) || []).length, 57);
  assert.equal(new Set([...html.matchAll(/id="(milestone-batch-\d+)"/g)].map((match) => match[1])).size, 60);
  assert.match(html.slice(0, overflow), /data-reader-anchor="milestone-batch-3"/);
  assert.equal(value.placedObservationIds.size, 60);
  assert.equal((html.match(/data-reader-coordination-content-url=/g) || []).length, 60);
  assert.equal((html.match(/data-reader-open /g) || []).length, 60);
});
