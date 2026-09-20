import assert from "node:assert/strict";
import test from "node:test";

import { extractDshMeta } from "../dist/src/providers/deepseek-harness/parser.js";
import { buildDshSessionProtocol, buildDshSessionProtocolV3 } from "../dist/src/providers/deepseek-harness/protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";
import {
  deriveReaderTeamDetailPage,
  deriveReaderTeamDirectoryPage,
  deriveReaderTeamTaskPage,
  hasReaderTeams,
  readerTeamDirectory,
  resolveReaderTeamTaskContent
} from "../dist/src/reader-teams.js";
import { renderReaderTeamDetail, renderReaderTeamGraph, renderReaderTeams } from "../dist/src/views/reader-teams.js";
import { anchorId } from "../dist/src/views/anchors.js";
import { deriveConversationTaskDirectoryPage } from "../dist/src/conversation-view-model.js";
import { setLocale } from "../dist/src/i18n.js";

const rootId = "team-root";
const header = { type: "session", version: 2, id: rootId, createdAt: 1000, isSeeded: false, delegationDepth: 0, agentPreset: "lead" };
const event = (type, seq, data) => ({ type, seq, time: 2000 + seq, data });

function teamProtocol(messageCount = 51, taskCount = 1, deliverLast = true) {
  const records = [header,
    event("team/member", 0, { version: 2, teamId: rootId, member: { id: "alice", name: "Alice", description: "Research", provider: "subagent", context: "fresh", phase: "active" } }),
    event("team/member", 1, { version: 2, teamId: rootId, member: { id: "bob", name: "Bob", description: "Review", provider: "subagent", context: "fresh", phase: "active" } })
  ];
  for (let index = 0; index < taskCount; index += 1) {
    records.push(event("team/task", records.length - 1, { version: 2, teamId: rootId, task: {
      id: `research-${index}`, revision: 1, subject: index === 0 ? "Inspect source" : `Inspect source ${index}`,
      description: index === taskCount - 1 && taskCount > 12
        ? `${"Detailed assignment ".repeat(400)}FINAL_ASSIGNMENT_SENTINEL`
        : `Read files ${index}`,
      status: "in_progress", ownerId: "alice", blockedBy: [], writeScopes: []
    } }));
  }
  for (let index = 0; index < messageCount; index += 1) {
    const seq = records.length - 1;
    const senderId = index % 2 ? "bob" : "alice";
    const targetId = index % 2 ? "alice" : "bob";
    const messageId = `message-${index}`;
    records.push(event("team/message/queued", seq, {
      version: 2, teamId: rootId,
      message: { id: messageId, senderId, senderName: senderId, targetId, delivery: "quiet", content: [{ type: "text", text: `Exchange ${index}` }] }
    }));
    if (deliverLast || index < messageCount - 1) {
      records.push(event("team/message/delivered", seq + 1, { version: 2, teamId: rootId, messageId, targetId }));
    }
  }
  const input = { session: extractDshMeta(records, rootId), records, messages: [], children: [] };
  const base = buildDshSessionProtocol(input);
  return finalizeSessionProtocolV3(buildDshSessionProtocolV3(input, base));
}

test("team reader only starts from explicit team actors and keeps missing child files readable through recorded exchanges", () => {
  const protocol = teamProtocol();
  assert.equal(hasReaderTeams(protocol), true);
  const directory = readerTeamDirectory(protocol);
  const alice = directory.find((item) => item.kind === "member" && item.member.name === "Alice");
  assert.equal(alice.member.sessionRef, null);
  assert.equal(alice.member.assignmentCount, 1);
  assert.equal(alice.member.responsibility, "Research");
  assert.equal(alice.member.messageCount, 51);
  assert.deepEqual(directory.filter((item) => item.kind === "communication").map((item) => item.communication.messageCount), [26, 25]);

  const records = [header, event("subagent/catalog", 0, { version: 0, childId: "ordinary-child", childCreatedAt: 1001, mode: "one-shot" })];
  const input = { session: extractDshMeta(records, rootId), records, messages: [], children: [] };
  const ordinary = finalizeSessionProtocolV3(buildDshSessionProtocolV3(input, buildDshSessionProtocol(input)));
  assert.equal(hasReaderTeams(ordinary), false, "ordinary parent-child evidence must not become a Team");
  assert.deepEqual(readerTeamDirectory(ordinary), []);
});

test("team provider identity cannot shadow a member actor that shares the root provider id", () => {
  const records = [header,
    event("team/member", 0, { version: 2, teamId: rootId, member: {
      id: rootId, name: "Lead", description: "Lead work", provider: "subagent", context: "fresh", phase: "active"
    } }),
    event("team/task", 1, { version: 2, teamId: rootId, task: {
      id: "lead-task", revision: 1, subject: "Lead assignment", description: "Keep ownership",
      status: "in_progress", ownerId: rootId, blockedBy: [], writeScopes: []
    } })
  ];
  const input = { session: extractDshMeta(records, rootId), records, messages: [], children: [] };
  const protocol = finalizeSessionProtocolV3(buildDshSessionProtocolV3(input, buildDshSessionProtocol(input)));
  assert.equal(protocol.validation.ok, true);
  const lead = readerTeamDirectory(protocol).find((item) => item.kind === "member");
  assert.equal(lead.member.name, "Lead");
  assert.equal(lead.member.assignmentCount, 1);
});

test("team directory and exchange cursors page every item and bind continuations to the same selection", () => {
  const protocol = teamProtocol();
  const firstDirectory = deriveReaderTeamDirectoryPage(protocol, { provider: "deepseek-harness", sessionId: rootId, size: 2 });
  assert.equal(firstDirectory.ok, true);
  assert.equal(firstDirectory.items.length, 2);
  assert.ok(firstDirectory.nextCursor);
  const nextDirectory = deriveReaderTeamDirectoryPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, size: 2, cursor: firstDirectory.nextCursor
  });
  assert.equal(nextDirectory.ok, true);
  assert.equal(nextDirectory.items.length, 2);
  assert.equal(nextDirectory.nextCursor, null);
  assert.equal(new Set([...firstDirectory.items, ...nextDirectory.items].map((item) => item.key)).size, 4);

  const edge = readerTeamDirectory(protocol).find((item) => item.kind === "communication" && item.communication.messageCount === 26);
  const first = deriveReaderTeamDetailPage(protocol, { provider: "deepseek-harness", sessionId: rootId, key: edge.key, size: 25 });
  assert.equal(first.ok, true);
  assert.equal(first.exchanges.length, 25);
  assert.ok(first.nextCursor);
  const second = deriveReaderTeamDetailPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, key: edge.key, size: 25, cursor: first.nextCursor
  });
  assert.equal(second.ok, true);
  assert.equal(second.exchanges.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.exchanges, ...second.exchanges].map((item) => item.observation.id)).size, 26);
  assert.equal(deriveReaderTeamDetailPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId,
    key: readerTeamDirectory(protocol).find((item) => item.kind === "member").key,
    size: 25, cursor: first.nextCursor
  }).code, "stale_cursor");
});

test("member assignments use an independent bounded cursor and remain readable to the last task", () => {
  const protocol = teamProtocol(2, 15);
  const alice = readerTeamDirectory(protocol).find((item) => item.kind === "member" && item.member.name === "Alice");
  const detail = deriveReaderTeamDetailPage(protocol, { provider: "deepseek-harness", sessionId: rootId, key: alice.key });
  assert.equal(detail.tasks.length, 12);
  assert.equal(detail.taskTotal, 15);
  assert.ok(detail.taskNextCursor);
  const rest = deriveReaderTeamTaskPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, key: alice.key,
    size: detail.taskSize, cursor: detail.taskNextCursor
  });
  assert.equal(rest.ok, true);
  assert.equal(rest.tasks.length, 3);
  assert.equal(rest.nextCursor, null);
  assert.equal(new Set([...detail.tasks, ...rest.tasks].map((task) => task.id)).size, 15);
  assert.equal(rest.tasks.at(-1).hasDescription, true);
  assert.equal("description" in rest.tasks.at(-1), false, "task pages expose a bounded summary rather than the full body");

  const byLaterTitle = deriveReaderTeamDirectoryPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, query: "Inspect source 14"
  });
  assert.equal(byLaterTitle.ok, true);
  assert.equal(byLaterTitle.total, 1, "search includes every indexed assignment title");
  const byDescription = deriveReaderTeamDirectoryPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, query: "FINAL_ASSIGNMENT_SENTINEL"
  });
  assert.equal(byDescription.ok, true);
  assert.equal(byDescription.total, 1, "search includes full normalized assignment descriptions");

  const content = resolveReaderTeamTaskContent(protocol, {
    provider: "deepseek-harness", sessionId: rootId, taskId: rest.tasks.at(-1).id
  });
  assert.equal(content.ok, true);
  assert.match(content.description, /FINAL_ASSIGNMENT_SENTINEL$/);
  assert.equal(content.revision.length, 64);
});

test("tasks covered by explicit Teams do not repeat in the generic agent task directory", () => {
  const protocol = teamProtocol(2, 15);
  const directory = deriveConversationTaskDirectoryPage(protocol, {
    provider: "deepseek-harness", sessionId: rootId, size: 50
  });
  assert.equal(directory.ok, true);
  assert.equal(directory.total, 0);
  assert.deepEqual(directory.items, []);
});

test("team graph and detail render bounded selectable relationships, complete continuation controls, sources and missing-history notice", () => {
  setLocale("en");
  const protocol = teamProtocol();
  const directory = deriveReaderTeamDirectoryPage(protocol, { provider: "deepseek-harness", sessionId: rootId, size: 3 });
  const overview = renderReaderTeams(directory);
  assert.equal((overview.match(/data-reader-team-select=/g) || []).length, 6, "three bounded entries appear once in graph and once in directory");
  assert.match(overview, /data-reader-team-directory-more/);
  assert.match(renderReaderTeamGraph(directory), /<h3>Membership and assignments<\/h3>/);
  assert.match(renderReaderTeamGraph(directory), /Member communication/);
  assert.match(renderReaderTeamGraph(directory), /Showing 1–3 of 4 members and paths/);
  assert.equal((renderReaderTeamGraph(directory).match(/reader-team-graph-team/g) || []).length, 1,
    "members share one stable team node instead of repeating the team for every row");

  const alice = readerTeamDirectory(protocol).find((item) => item.kind === "member" && item.member.name === "Alice");
  const detail = deriveReaderTeamDetailPage(protocol, { provider: "deepseek-harness", sessionId: rootId, key: alice.key, size: 50 });
  const html = renderReaderTeamDetail(detail);
  assert.match(html, /data-reader-team-back/);
  assert.match(html, /<h3 tabindex="-1" data-reader-team-detail-title>Alice<\/h3>/);
  assert.match(html, /no separate local session file/i);
  assert.match(html, /Inspect source/);
  assert.match(html, /data-reader-coordination-content-url=/);
  assert.match(html, /data-reader-event-source/);
  assert.match(html, /data-reader-team-exchanges-more/);
  assert.match(html, /Queued at/);
  assert.match(html, /Delivered at/);
  assert.equal((html.match(/data-reader-coordination-item/g) || []).length, 50);
  assert.doesNotMatch(html, /Exchange 50/, "message bodies stay on-demand rather than hidden in initial HTML");

  const withChild = {
    ...protocol,
    actors: protocol.actors.map((actor) => actor.providerActorId === "alice"
      ? { ...actor, sessionRef: { provider: "deepseek-harness", sessionId: "alice-child" } }
      : actor)
  };
  const childAlice = readerTeamDirectory(withChild).find((item) => item.kind === "member" && item.member.name === "Alice");
  const childDetail = deriveReaderTeamDetailPage(withChild, {
    provider: "deepseek-harness", sessionId: rootId, key: childAlice.key
  });
  const childHtml = renderReaderTeamDetail(childDetail);
  assert.match(childHtml, new RegExp(`id="${anchorId("team-history", childAlice.key)}"`),
    "member history links expose a stable focus identity for browser Back");
});

test("team exchange timing keeps queued and delivered observations distinct and does not invent delivery time", () => {
  setLocale("en");
  const protocol = teamProtocol(1, 1, false);
  const edge = readerTeamDirectory(protocol).find((item) => item.kind === "communication");
  const page = deriveReaderTeamDetailPage(protocol, { provider: "deepseek-harness", sessionId: rootId, key: edge.key });
  const html = renderReaderTeamDetail(page);
  assert.match(html, /Queued at/);
  assert.doesNotMatch(html, /Delivered at/);
  assert.match(html, /data-reader-state="requested"/);

  const withRecordedDelivery = teamProtocol(1, 1);
  const recordedDeliveryWithoutTime = {
    ...withRecordedDelivery,
    coordination: withRecordedDelivery.coordination.map((observation) =>
      observation.kind === "mailbox-delivery" ? { ...observation, timestamp: null } : observation)
  };
  const deliveredEdge = readerTeamDirectory(recordedDeliveryWithoutTime).find((item) => item.kind === "communication");
  const deliveredPage = deriveReaderTeamDetailPage(recordedDeliveryWithoutTime, {
    provider: "deepseek-harness", sessionId: rootId, key: deliveredEdge.key
  });
  const deliveredHtml = renderReaderTeamDetail(deliveredPage);
  assert.match(deliveredHtml, /data-reader-state="delivered"/);
  assert.match(deliveredHtml, /Delivered at Time not recorded/);
});
