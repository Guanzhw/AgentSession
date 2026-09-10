import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentLoop } from "../dist/src/providers/shared/agent-loop.js";

function assistant(id, content, presentationPhase, metadata = {}) {
  return {
    id,
    sessionId: "root",
    role: "assistant",
    content,
    thinking: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    tokens: null,
    metadata: { turnId: "turn-1", ...metadata },
    ...(presentationPhase ? { presentationPhase } : {})
  };
}

test("Agent Loop keeps commentary, final, and unknown assistant boundaries", () => {
  const { turns } = buildAgentLoop([
    assistant("commentary-1", "first commentary", "commentary"),
    assistant("commentary-2", "second commentary", "commentary"),
    assistant("final-1", "recorded final", "final"),
    assistant("unknown-1", "unclassified communication", undefined),
    assistant("final-2", "another recorded final", "final")
  ]);

  assert.deepEqual(turns.map((turn) => turn.data.presentationPhase), ["commentary", "final", undefined, "final"]);
  assert.deepEqual(turns.map((turn) => turn.events.map((event) => event.text)), [
    ["first commentary", "second commentary"],
    ["recorded final"],
    ["unclassified communication"],
    ["another recorded final"]
  ]);
});

test("Agent Loop keeps same-phase fragments and tool events in one turn", () => {
  const { turns } = buildAgentLoop([
    assistant("final-1", "before tool", "final"),
    {
      id: "tool-1",
      sessionId: "root",
      role: "tool",
      content: "tool output",
      thinking: null,
      toolName: "read",
      toolInput: { path: "README.md" },
      toolOutput: "tool output",
      timestamp: 2,
      tokens: null,
      metadata: { turnId: "turn-1", callId: "call-1" }
    },
    assistant("final-2", "after tool", "final")
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.presentationPhase, "final");
  assert.deepEqual(turns[0].events.map((event) => event.kind), ["text", "tool", "text"]);
  assert.equal(turns[0].events[1].output, "tool output");
});

test("Agent Loop preserves legacy phase-less grouping", () => {
  const { turns } = buildAgentLoop([
    assistant("legacy-1", "first legacy fragment"),
    assistant("legacy-2", "second legacy fragment")
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.presentationPhase, undefined);
  assert.deepEqual(turns[0].events.map((event) => event.text), ["first legacy fragment", "second legacy fragment"]);
});

test("Agent Loop attaches phase-less reasoning to the explicit final text", () => {
  const { turns } = buildAgentLoop([
    {
      ...assistant("reasoning-1", "", undefined),
      thinking: "Reasoning stays with the response."
    },
    assistant("final-1", "recorded final", "final")
  ]);

  assert.equal(turns.length, 1);
  assert.equal(turns[0].data.presentationPhase, "final");
  assert.deepEqual(turns[0].events.map((event) => event.kind), ["reasoning", "text"]);
  assert.equal(turns[0].events[0].text, "Reasoning stays with the response.");
});

test("Agent Loop never relabels existing unknown text as a later final", () => {
  const { turns } = buildAgentLoop([
    assistant("unknown-1", "unclassified communication", undefined),
    assistant("final-1", "recorded final", "final")
  ]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0].data.presentationPhase, undefined);
  assert.equal(turns[0].events[0].text, "unclassified communication");
  assert.equal(turns[1].data.presentationPhase, "final");
});
