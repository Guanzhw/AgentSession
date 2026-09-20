import assert from "node:assert/strict";
import test from "node:test";

import { dshTeamCoordinationContent } from "../dist/src/providers/deepseek-harness/coordination-content.js";

const longText = "Complete team message\n\n" + "正文🙂\n".repeat(1800);
const records = [
  { type: "session", version: 2, id: "root", createdAt: 1, isSeeded: true, delegationDepth: 0 },
  { type: "team/message/queued", seq: 0, time: 2, data: { teamId: "root", message: { id: "same", content: [{ type: "text", text: "inherited message" }] } } },
  { type: "session/end-seed", seq: 1, time: 3, data: { inherited: true } },
  { type: "team/message/queued", seq: 2, time: 4, data: { teamId: "root", message: { id: "same", content: [{ type: "text", text: longText }, { type: "reference", path: "notes.md" }] } } },
  { type: "team/message/delivered", seq: 3, time: 5, data: { teamId: "root", messageId: "same", targetId: "worker" } }
];

const observation = {
  id: "coord:dsh:team-message:same:queued", sessionId: "root", kind: "message", state: "requested",
  timestamp: 4, correlationId: "same", eventId: "event:dsh:2", turnId: null,
  provenance: { fidelity: "recorded", sourceType: "dsh.session-event:team/message/queued", sourceId: "2" }
};

test("DSH team content reads the exact owned queued record and preserves every recorded content block", () => {
  const content = dshTeamCoordinationContent(records, observation);
  assert.equal(content.format, "markdown");
  assert.ok(content.text.startsWith(longText));
  assert.match(content.text, /```json\n[\s\S]*"type": "reference"[\s\S]*"path": "notes.md"/);
  assert.doesNotMatch(content.text, /inherited message/);
});

test("DSH delivery reuses only its exact owned queued message body", () => {
  const delivery = {
    ...observation, id: "coord:dsh:team-message:same:delivered", kind: "mailbox-delivery", timestamp: 5,
    eventId: "event:dsh:3", provenance: { ...observation.provenance, sourceType: "dsh.session-event:team/message/delivered", sourceId: "3" }
  };
  assert.deepEqual(dshTeamCoordinationContent(records, delivery), dshTeamCoordinationContent(records, observation));
  assert.equal(dshTeamCoordinationContent(records, { ...delivery, correlationId: "other" }), null);
});

test("DSH team content does not substitute ids, queued source positions, or ambiguous queued records", () => {
  assert.equal(dshTeamCoordinationContent(records, { ...observation, correlationId: "other" }), null);
  assert.equal(dshTeamCoordinationContent(records, { ...observation, provenance: { ...observation.provenance, sourceId: "0" } }), null);
  assert.equal(dshTeamCoordinationContent(records, { ...observation, eventId: "event:dsh:99" }), null);
  const duplicate = [...records, { type: "team/message/queued", seq: 4, time: 6, data: { teamId: "root", message: { id: "same", content: [{ type: "text", text: "duplicate" }] } } }];
  assert.equal(dshTeamCoordinationContent(duplicate, {
    ...observation, kind: "mailbox-delivery", eventId: "event:dsh:3",
    provenance: { ...observation.provenance, sourceType: "dsh.session-event:team/message/delivered", sourceId: "3" }
  }), null);
});
