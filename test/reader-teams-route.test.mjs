import assert from "node:assert/strict";
import test from "node:test";

import { extractDshMeta } from "../dist/src/providers/deepseek-harness/parser.js";
import { buildDshSessionProtocol, buildDshSessionProtocolV3 } from "../dist/src/providers/deepseek-harness/protocol.js";
import { finalizeSessionProtocolV3 } from "../dist/src/providers/shared/session-protocol-v3.js";
import { registerReaderTeamRoutes } from "../dist/src/routes/reader-teams.js";

const provider = "deepseek-harness";
const sessionId = "team-route-fixture";
const header = { type: "session", version: 2, id: sessionId, createdAt: 1000, isSeeded: false, delegationDepth: 0, agentPreset: "lead" };

function protocolFixture() {
  const records = [header];
  const push = (type, data) => records.push({ type, seq: records.length - 1, time: 2000 + records.length, data });
  push("team/member", { version: 2, teamId: sessionId, member: {
    id: "alice", name: "Alice", description: `${"Long responsibility ".repeat(400)}MEMBER_FINAL_SENTINEL`,
    provider: "subagent", context: "fresh", phase: "active"
  } });
  push("team/member", { version: 2, teamId: sessionId, member: {
    id: "bob", name: "Bob", description: "Review", provider: "subagent", context: "fresh", phase: "active"
  } });
  for (let index = 0; index < 15; index += 1) {
    push("team/task", { version: 2, teamId: sessionId, task: {
      id: `task-${index}`, revision: 1, subject: `Assignment ${index}`,
      description: index === 14 ? `${"Long task detail ".repeat(500)}TASK_FINAL_SENTINEL` : `Detail ${index}`,
      status: "in_progress", ownerId: "alice", blockedBy: [], writeScopes: []
    } });
  }
  for (let index = 0; index < 51; index += 1) {
    const senderId = index % 2 ? "bob" : "alice";
    const targetId = index % 2 ? "alice" : "bob";
    const messageId = `message-${index}`;
    push("team/message/queued", { version: 2, teamId: sessionId, message: {
      id: messageId, senderId, senderName: senderId, targetId, delivery: "quiet",
      content: [{ type: "text", text: `Exchange ${index}` }]
    } });
    push("team/message/delivered", { version: 2, teamId: sessionId, messageId, targetId });
  }
  const input = { session: extractDshMeta(records, sessionId), records, messages: [], children: [] };
  return finalizeSessionProtocolV3(buildDshSessionProtocolV3(input, buildDshSessionProtocol(input)));
}

function routeHarness(protocol) {
  const routes = [];
  const adapter = {
    id: provider,
    getSession(id) { return id === sessionId ? { id, timeUpdated: 1, messageCount: 1, tokenCount: 0 } : null; },
    getSessionProtocolV3(id) { return id === sessionId ? protocol : null; },
    getStatsRevision() { return 1; }
  };
  registerReaderTeamRoutes({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    providerMap: new Map([[provider, adapter]])
  });
  return async (url) => {
    const parsed = new URL(url, "http://localhost");
    const route = routes.find(({ pattern }) => pattern.test(parsed.pathname));
    assert.ok(route, `route exists for ${parsed.pathname}`);
    const response = {
      status: 0,
      body: "",
      setHeader() {},
      writeHead(status) { this.status = status; },
      end(body = "") { this.body = body; }
    };
    await route.handler({ url: `${parsed.pathname}${parsed.search}` }, response, parsed.pathname.match(route.pattern));
    return { status: response.status, data: JSON.parse(response.body) };
  };
}

test("team routes continue directory, exchanges and assignments without returning lazy descriptions", async () => {
  const request = routeHarness(protocolFixture());
  const directory = await request(`/api/${provider}/session/${sessionId}/reader/teams?size=2`);
  assert.equal(directory.status, 200);
  assert.equal(directory.data.items.length, 2);
  assert.ok(directory.data.nextCursor);
  assert.doesNotMatch(JSON.stringify(directory.data), /MEMBER_FINAL_SENTINEL/,
    "directory returns a bounded responsibility summary, not the complete member body");

  const memberKey = directory.data.items.find((item) => item.kind === "member" && item.member.name === "Alice").key;
  const detail = await request(`/api/${provider}/session/${sessionId}/reader/team?key=${encodeURIComponent(memberKey)}&size=50`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.tasks.length, 12);
  assert.ok(detail.data.taskNextCursor);
  assert.ok(detail.data.nextCursor);
  assert.doesNotMatch(JSON.stringify(detail.data), /TASK_FINAL_SENTINEL/,
    "detail JSON does not leak lazy task descriptions or metadata");

  const tasks = await request(`/api/${provider}/session/${sessionId}/reader/team/tasks?key=${encodeURIComponent(memberKey)}&size=${detail.data.taskSize}&cursor=${encodeURIComponent(detail.data.taskNextCursor)}`);
  assert.equal(tasks.status, 200);
  assert.equal(tasks.data.tasks.length, 3);
  assert.equal(tasks.data.nextCursor, null);
  assert.equal(tasks.data.tasks.at(-1).hasDescription, true);
  assert.doesNotMatch(JSON.stringify(tasks.data), /TASK_FINAL_SENTINEL/);

  const exchanges = await request(`/api/${provider}/session/${sessionId}/reader/team?key=${encodeURIComponent(memberKey)}&size=50&cursor=${encodeURIComponent(detail.data.nextCursor)}`);
  assert.equal(exchanges.status, 200);
  assert.equal(exchanges.data.exchanges.length, 1);
  assert.equal(exchanges.data.nextCursor, null);
});

test("team description routes page to the final content and reject stale continuation identities", async () => {
  const request = routeHarness(protocolFixture());
  const firstTask = await request(`/api/${provider}/session/${sessionId}/reader/team/task/${encodeURIComponent("team:task-14")}/content?offset=0`);
  assert.equal(firstTask.status, 200);
  assert.ok(firstTask.data.nextOffset);
  assert.doesNotMatch(firstTask.data.html, /TASK_FINAL_SENTINEL/);
  const lastTask = await request(`/api/${provider}/session/${sessionId}/reader/team/task/${encodeURIComponent("team:task-14")}/content?offset=${firstTask.data.nextOffset}&revision=${firstTask.data.revision}`);
  assert.equal(lastTask.status, 200);
  assert.match(lastTask.data.html, /TASK_FINAL_SENTINEL/);
  assert.equal(lastTask.data.nextOffset, null);
  const staleTask = await request(`/api/${provider}/session/${sessionId}/reader/team/task/${encodeURIComponent("team:task-14")}/content?offset=${firstTask.data.nextOffset}&revision=stale`);
  assert.equal(staleTask.status, 409);
  assert.equal(staleTask.data.code, "stale_content");

  const directory = await request(`/api/${provider}/session/${sessionId}/reader/teams?size=2`);
  const alice = directory.data.items.find((item) => item.kind === "member" && item.member.name === "Alice");
  const firstMember = await request(`/api/${provider}/session/${sessionId}/reader/team/member/${encodeURIComponent(alice.member.actorId)}/content?offset=0`);
  assert.equal(firstMember.status, 200);
  assert.ok(firstMember.data.nextOffset);
  const lastMember = await request(`/api/${provider}/session/${sessionId}/reader/team/member/${encodeURIComponent(alice.member.actorId)}/content?offset=${firstMember.data.nextOffset}&revision=${firstMember.data.revision}`);
  assert.equal(lastMember.status, 200);
  assert.match(lastMember.data.html, /MEMBER_FINAL_SENTINEL/);
});
