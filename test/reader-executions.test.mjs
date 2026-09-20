import assert from "node:assert/strict";
import test from "node:test";
import { deriveReaderExecutions, readerExecutionPage, executionTimeRange } from "../dist/src/reader-executions.js";
import { appendReaderExecutionMarkers, renderReaderExecutionPage } from "../dist/src/views/reader-executions.js";
import { publicEvent } from "../dist/src/protocol-runtime.js";

const provenance = { fidelity: "recorded", sourceType: "fixture" };
function event(id, phase, timestamp, callId = id, executionId = "start") {
  return { id, sessionId: "root", sequence: 1, timestamp, kind: `tool.execution.${phase}`, category: "tool",
    messageId: callId, toolCallId: callId, provenance,
    execution: { id: executionId, kind: "async-tool", phase, handle: "12", toolName: "exec" } };
}
function fixture(events = [event("start", "started", 1000), event("yield", "yielded", 2000, "start"),
  event("poll", "polled", 4000), event("done", "completed", 5000, "poll")]) {
  const uniqueCalls = [...new Set(events.map((item) => item.toolCallId).filter(Boolean))];
  const document = { messages: [...uniqueCalls.map((id) => ({ id })), { id: "prose-message" }],
    partsByMessage: new Map([...uniqueCalls.map((id) => [id, [{ id: `part-${id}`, data: { type: "tool", callID: id } }]]),
      ["prose-message", [{ id: "prose-part", data: { type: "text", text: "The main agent continued its analysis." } }]]]) };
  const protocol = { session: { ref: { provider: "fixture", sessionId: "root" } },
    events: [...events, { id: "prose", sequence: 3, category: "message", timestamp: 3000, messageId: "prose-message", provenance }]
      .sort((a, b) => a.timestamp - b.timestamp).map((item, index) => ({ ...item, sequence: index + 1 })) };
  return { document, protocol, view: deriveReaderExecutions(protocol, document) };
}

test("reader async execution groups exact occurrences and locates output after the producing tool", () => {
  const { view } = fixture();
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].steps.length, 4);
  assert.deepEqual(view.items[0].steps[1].position, { messageId: "start", partId: "part-start", side: "after" });
  assert.deepEqual(view.items[0].steps[2].position, { messageId: "poll", partId: "part-poll", side: "before" });
  assert.equal(view.prose.length, 1);
  const markup = appendReaderExecutionMarkers(null, view);
  assert.equal(markup.parts.size, 2, "one yielding landmark and one returned result; polls stay inside execution details");
  assert.match(markup.parts.get("after\u0000part-start"), /data-reader-execution-phase="yielded"/);
  assert.match(markup.parts.get("after\u0000part-poll"), /data-reader-execution-phase="completed"/);
  assert.equal(markup.processPositions.size, 0);
  assert.match(markup.parts.get("after\u0000part-start"), /#execution-done/);
});

test("ordinary conversation has no async markers, and missing native parts are not guessed", () => {
  const { view, protocol, document } = fixture();
  assert.equal(appendReaderExecutionMarkers(null, { ...view, items: [] }), null);
  assert.deepEqual(deriveReaderExecutions({ ...protocol, events: [] }, document).items, []);
  const unavailable = deriveReaderExecutions(protocol, { messages: [], partsByMessage: new Map() });
  assert.equal(unavailable.items[0].steps.every((step) => step.position === null), true);
  assert.equal(appendReaderExecutionMarkers(null, unavailable).parts.size, 0);
});

test("execution time lanes use selected interval and distinct overlapping occurrences", () => {
  const { view } = fixture([
    event("start", "started", 1000), event("yield", "yielded", 2000, "start"),
    event("peer-start", "started", 2500, "peer-start", "peer"), event("peer-yield", "yielded", 2800, "peer-start", "peer"),
    event("peer-done", "completed", 4000, "peer-poll", "peer"), event("done", "completed", 5000, "poll")
  ]);
  const html = renderReaderExecutionPage(readerExecutionPage(view, "start", null));
  assert.equal((html.match(/class="reader-execution-time-row/g) || []).length, 3);
  assert.match(html, /reader-execution-connectors/);
  assert.match(html, /d="M26 30 V88/, "separation is at yielded time, not call startup");
  assert.match(html, /The main agent continued its analysis/);
  assert.equal((html.match(/data-reader-execution-step=/g) || []).length, 3);
  assert.match(html, /data-reader-event-id="done"/);
  assert.doesNotMatch(html, /data-reader-task-select|reader-open/);
});

test("all execution steps continue in bounded pages and cursor permits append but detects changed prefix", () => {
  const events = Array.from({ length: 122 }, (_, index) => event(`event-${index}`, index === 0 ? "started" : index === 1 ? "yielded" : "polled", index + 1));
  const { view } = fixture(events);
  const one = readerExecutionPage(view, "start", null);
  assert.equal(one.steps.length, 50);
  const two = readerExecutionPage(view, "start", one.nextCursor);
  const three = readerExecutionPage(view, "start", two.nextCursor);
  assert.deepEqual([two.steps.length, three.steps.length, three.nextCursor], [50, 22, null]);
  assert.equal(new Set([...one.steps, ...two.steps, ...three.steps].map((item) => item.eventId)).size, 122);
  view.items[0].steps.push({ ...three.steps.at(-1), eventId: "append" });
  assert.equal(readerExecutionPage(view, "start", two.nextCursor).steps.length, 23);
  view.items[0].steps[0] = { ...one.steps[0], timestamp: 99 };
  assert.throws(() => readerExecutionPage(view, "start", one.nextCursor), { code: "stale_page" });
  assert.throws(() => readerExecutionPage(view, "missing", null), { code: "execution_not_found" });
  assert.throws(() => readerExecutionPage(view, "start", "bad"), { code: "invalid_input" });
});

test("polling and interruption requests do not invent a returned result or duration", () => {
  const { view } = fixture([event("start", "started", 1000), event("yield", "yielded", 2000, "start"), event("stop", "interruption-requested", 3000)]);
  const html = renderReaderExecutionPage(readerExecutionPage(view, "start", null));
  assert.match(html, /No returned result is saved/);
  assert.match(html, /Stop requested/);
  assert.match(html, /is-open/);
  assert.doesNotMatch(html, /Result returned|>Stopped</);
  const missingTimes = { ...view.items[0], steps: view.items[0].steps.map((step) => ({ ...step, timestamp: null })) };
  assert.equal(executionTimeRange(missingTimes), null);
  assert.equal(executionTimeRange({ ...missingTimes, steps: view.items[0].steps.map((step, index) => ({ ...step, timestamp: 3000 - index * 1000 })) }), null);
});

test("runtime public events retain normalized execution details without raw output", () => {
  const input = event("yield", "yielded", 2000, "start");
  const result = publicEvent(input);
  assert.deepEqual(result.execution, input.execution);
  assert.equal("providerData" in result, false);
});

test("background commands use normalized command labels and share the full execution reading path", () => {
  const events = [event("start", "started", 1000), event("yield", "yielded", 2000, "start"),
    event("input", "input", 3000), event("done", "completed", 4000, "input")].map((item, index) => ({
      ...item, execution: { ...item.execution, kind: "process", toolName: index < 2 ? "exec_command" : "write_stdin",
        ...(index === 0 ? { label: 'npm run build <untrusted>' } : {}) }
    }));
  const { view } = fixture(events);
  assert.equal(view.items[0].name, "npm run build <untrusted>");
  const html = renderReaderExecutionPage(readerExecutionPage(view, "start", null));
  assert.match(html, /Background command/);
  assert.match(html, /npm run build &lt;untrusted&gt;/);
  assert.match(html, /Sent input/);
  assert.match(html, /data-reader-event-id="input"/);
  assert.equal((html.match(/data-reader-execution-step=/g) || []).length, 4);
  assert.doesNotMatch(html, /<untrusted>/);
  assert.match(appendReaderExecutionMarkers(null, view).parts.get("after\u0000part-start"), /Background command/);
});

test("an outer call overlapping before it yields is not drawn as parallel background work", () => {
  const { view } = fixture([
    event("start", "started", 1000), event("yield", "yielded", 2000, "start"), event("done", "completed", 5000, "poll"),
    event("later", "started", 4900, "later", "later"), event("later-yield", "yielded", 5100, "later", "later"),
    event("later-end", "completed", 6000, "later-wait", "later")
  ]);
  const html = renderReaderExecutionPage(readerExecutionPage(view, "start", null));
  assert.equal((html.match(/class="reader-execution-time-row/g) || []).length, 2);
  const noYieldTime = { ...view.items[0], steps: view.items[0].steps.map((step) => ({ ...step, timestamp: step.observation.phase === "yielded" ? null : step.timestamp })) };
  assert.equal(executionTimeRange(noYieldTime), null);
});

test("peer endpoints outside the selected time window are not relocated onto its boundaries", () => {
  const { view } = fixture([
    event("peer-start", "started", 100, "peer-start", "peer"), event("peer-yield", "yielded", 200, "peer-start", "peer"),
    event("start", "started", 1000), event("yield", "yielded", 2000, "start"), event("done", "completed", 5000, "poll"),
    event("peer-end", "completed", 6000, "peer-wait", "peer")
  ]);
  const html = renderReaderExecutionPage(readerExecutionPage(view, "start", null));
  const peerRow = html.slice(html.indexOf('data-reader-event-id="peer-yield"')).split('</div></div>')[0];
  assert.match(html, /Continues beyond this window/);
  assert.doesNotMatch(peerRow, /class="reader-execution-dot"/);
  assert.match(peerRow, /reader-execution-time-span/);
});
