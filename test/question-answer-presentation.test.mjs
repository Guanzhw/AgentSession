import assert from "node:assert/strict";
import test from "node:test";
import { recordsToMessages } from "../dist/src/providers/codex/parser.js";
import { buildMessageSessionTree } from "../dist/src/providers/shared/message-session.js";
import { questionAnswersText } from "../dist/src/providers/shared/question-answers.js";
import { searchNormalizedMessages } from "../dist/src/providers/shared/file-adapter-helpers.js";
import { buildPartsFromProviderMessages, getSessionDocument } from "../dist/src/session-queries.js";
import { renderSessionReaderPane } from "../dist/src/views/session.js";
import { messageBubble, renderProgressiveContent, resolveProgressiveField } from "../dist/src/views/components.js";
import { registerSessionDetail } from "../dist/src/routes/session-detail.js";
import { escapeHtml } from "../dist/src/markdown.js";

const session = { id: "qa-session", title: "Recorded question", timeCreated: 1, timeUpdated: 2 };
const question = { questionItemId: "recorded-item", question: "Choose a needle?", answer: "needle choice" };
const envelope = (items) => `<send_user_message_question_reply>\n${JSON.stringify(items)}\n</send_user_message_question_reply>`;
const userRecord = (text) => ({
  type: "response_item", timestamp: "2026-09-01T00:00:00Z",
  payload: {
    type: "message", id: "recorded-message", role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"], turn_id: "recorded-turn" }
  }
});
const messagesFrom = (text) => recordsToMessages([userRecord(text)], session.id);
const providerFor = (messages) => ({
  id: "fixture", name: "Fixture", icon: "",
  getSession(id) { return id === session.id ? session : null; },
  getMessages() { return messages; }
});

function routesFor(messages) {
  const routes = [];
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: ".", resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", providerFor(messages)]]), providerInfo: []
  });
  return async (endpoint, query = "") => {
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.source.endsWith(`${endpoint}$`));
    assert.ok(route, endpoint);
    const pathname = `/api/fixture/session/${session.id}/${endpoint}`;
    const response = { statusCode: 0, body: "", writeHead(status) { this.statusCode = status; }, end(body = "") { this.body += body; } };
    await route.handler({ url: `${pathname}?${query}` }, response, pathname.match(route.pattern));
    return response;
  };
}

test("Codex records complete user question replies beside unchanged raw content and identities", () => {
  const items = [question, { questionItemId: "second-item", question: "Second question", answer: "Second answer" }];
  const raw = envelope(items);
  const [message] = messagesFrom(raw);
  assert.equal(message.id, "recorded-message");
  assert.equal(message.role, "user");
  assert.equal(message.content, raw);
  assert.equal(message.metadata.turnId, "recorded-turn");
  assert.equal(message.metadata.provenance, "session");
  assert.deepEqual(message.questionAnswers, items.map(({ questionItemId, ...item }) => ({ id: questionItemId, ...item })));
  assert.equal(message.toolName, null, "question IDs do not manufacture a tool relationship");
});

test("malformed or mixed question reply envelopes remain ordinary complete user text", () => {
  const inputs = [
    "<send_user_message_question_reply>{invalid}</send_user_message_question_reply>",
    envelope([]), envelope({ ...question }), envelope([{ ...question, answer: 12 }]),
    envelope([{ question: "missing ID", answer: "a" }]),
    `Quoted example: ${envelope([question])}`, `${envelope([question])}\nExtra prose`,
    envelope([question]).replace("</send_user_message_question_reply>", "")
  ];
  for (const raw of inputs) {
    const [message] = messagesFrom(raw);
    assert.equal(message.content, raw);
    assert.equal(message.questionAnswers, undefined);
  }
});

test("question reply recognition stays on recorded user text and preserves hybrid deduplication", () => {
  const raw = envelope([question]);
  const assistant = userRecord(raw);
  assistant.payload.role = "assistant";
  assert.equal(recordsToMessages([assistant], session.id)[0]?.questionAnswers, undefined);
  const untagged = userRecord(raw);
  delete untagged.payload.internal_chat_message_metadata_passthrough;
  assert.equal(recordsToMessages([untagged], session.id).length, 0);
  const messages = recordsToMessages([
    { type: "event_msg", payload: { type: "user_message", message: raw }, timestamp: "2026-09-01T00:00:00Z" },
    userRecord(raw)
  ], session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "recorded-message");
  assert.equal(messages[0].questionAnswers.length, 1);
});

test("reader tree and mapped document keep a single canonical raw part plus the same typed presentation", () => {
  const messages = messagesFrom(envelope([question]));
  const tree = buildMessageSessionTree(session, messages);
  const document = buildPartsFromProviderMessages(messages);
  const treePart = tree.messages[0].parts[0];
  const documentPart = document.partsByMessage.get(messages[0].id)[0];
  assert.equal(tree.messages.length, 1);
  assert.equal(tree.messages[0].parts.length, 1);
  assert.equal(treePart.id, "recorded-message:text");
  assert.equal(documentPart.id, treePart.id);
  assert.deepEqual(documentPart.data, treePart.data);
  assert.equal(treePart.data.text, messages[0].content);
  assert.deepEqual(treePart.data.questionAnswers, messages[0].questionAnswers);
});

test("reader and ToC present escaped question answers with one closed raw disclosure and stable anchors", () => {
  const item = { ...question, question: "Choose <script>needle</script>?", answer: "literal **needle** & choice" };
  const messages = messagesFrom(envelope([item]));
  const tree = buildMessageSessionTree(session, messages);
  const html = renderSessionReaderPane({ session, sessionTree: tree, provider: "fixture" });
  const body = html.match(/<div class="message-body question-answers"[^>]*>([\s\S]*?)<\/dl><\/div>/)?.[1];
  assert.ok(body);
  assert.match(body, /data-content-field|question-answer-chunk/);
  assert.ok(body.includes(escapeHtml(item.question)));
  assert.ok(body.includes(escapeHtml(item.answer)));
  assert.doesNotMatch(body, /send_user_message_question_reply|questionItemId|<script>/);
  assert.match(html, /<details class="question-answer-raw" data-search-exclude>/);
  assert.ok(html.includes(escapeHtml(messages[0].content)));
  assert.match(html, /href="#msg-recorded-message"[^>]*>[\s\S]*?Choose &lt;script&gt;needle/);
  assert.equal((html.match(/id="part-recorded-message-text"/g) || []).length, 1);
});

test("question answer continuation uses presentation offsets and preserves all field text exactly once", () => {
  const items = [
    { id: "one", question: "Question needle\nwith new line", answer: `${"长🙂 answer ".repeat(1600)}needle-late` },
    { id: "two", question: "Second needle", answer: "Last answer" }
  ];
  const text = questionAnswersText(items);
  let offset = 0;
  let renderedValues = "";
  let pages = 0;
  do {
    const page = renderProgressiveContent(items, "question-answer", offset, 12000);
    assert.equal(page.totalLength, text.length);
    assert.doesNotMatch(page.html, /questionItemId|send_user_message_question_reply/);
    renderedValues += [...page.html.matchAll(/<dd class="question-answer-value">([\s\S]*?)<\/dd>/g)].map((match) => match[1]).join("");
    assert.ok(page.nextOffset === null || page.nextOffset > offset);
    offset = page.nextOffset;
    pages += 1;
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.equal(renderedValues, escapeHtml(items.flatMap(({ question, answer }) => [question, answer]).join("")));
  const raw = envelope(items.map(({ id, ...item }) => ({ questionItemId: id, ...item })));
  const html = messageBubble("user", raw, { partId: "recorded-message:text", questionAnswers: items });
  assert.match(html, /data-progressive-field="question-answer"/);
  assert.match(html, /class="question-answer-raw" data-search-exclude>[\s\S]*data-progressive-field="text"/);
  assert.equal(resolveProgressiveField({ type: "text", text: raw, questionAnswers: items }, "text").format, "plain");
});

test("reader search returns one occurrence per visible question answer and continuation resolves the same field", async () => {
  const item = { ...question, answer: `${"padding ".repeat(1700)}needle-late` };
  const raw = envelope([item]);
  const messages = messagesFrom(raw);
  const request = routesFor(messages);
  const text = questionAnswersText(messages[0].questionAnswers);
  const response = await request("search", "q=needle&limit=1");
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.total, 2, "raw duplicate and display labels are excluded");
  assert.equal(result.nextOffset, 1);
  assert.deepEqual(result.matches.map(({ field, partId, format, offset }) => ({ field, partId, format, offset })), [
    { field: "question-answer", partId: "recorded-message:text", format: "plain", offset: text.indexOf("needle") }
  ]);
  const second = JSON.parse((await request("search", "q=needle&offset=1&limit=1")).body).matches[0];
  assert.equal(second.matchIndex, 1);
  assert.equal(second.offset, text.lastIndexOf("needle"));
  const content = JSON.parse((await request("content", "part=recorded-message:text&field=question-answer&offset=0")).body);
  assert.equal(content.totalLength, text.length);
  assert.ok(content.nextOffset > 0);
  const next = JSON.parse((await request("content", `part=recorded-message:text&field=question-answer&offset=${content.nextOffset}`)).body);
  assert.match(next.html, /needle-late/);
  const rawContent = JSON.parse((await request("content", "part=recorded-message:text&field=text&offset=0")).body);
  assert.equal(rawContent.totalLength, raw.length);
  assert.match(rawContent.html, /&lt;send_user_message_question_reply&gt;/);
  for (const query of ["send_user_message_question_reply", "recorded-item", "questionItemId"]) {
    assert.equal(JSON.parse((await request("search", `q=${query}`)).body).total, 0);
  }
});

test("ordinary and malformed text retain their original search and continuation behavior", async () => {
  const raw = `${envelope([question])} mixed prose`;
  const request = routesFor(messagesFrom(raw));
  const result = JSON.parse((await request("search", "q=questionItemId")).body);
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].field, "text");
  assert.equal((await request("content", "part=recorded-message:text&field=question-answer&offset=0")).statusCode, 404);
});

test("global provider search uses readable question answer text while preserving message identity", () => {
  const messages = messagesFrom(envelope([question]));
  const entries = [{ session, messages }];
  const hits = searchNormalizedMessages(entries, "needle");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].messageId, "recorded-message");
  assert.doesNotMatch(hits[0].snippet, /send_user_message_question_reply|questionItemId/);
  assert.equal(searchNormalizedMessages(entries, "questionItemId").length, 0);
});

test("raw export messages and Markdown retain the complete provider wrapper", async () => {
  const raw = envelope([question]);
  const messages = messagesFrom(raw);
  const document = getSessionDocument(providerFor(messages), "fixture", session.id);
  assert.equal(document.exportMessages[0].parts[0].text, raw);
  assert.deepEqual(document.exportMessages[0].parts[0].questionAnswers, messages[0].questionAnswers);
  const request = routesFor(messages);
  const markdown = await request("export", "format=md");
  assert.equal(markdown.statusCode, 200);
  assert.ok(markdown.body.includes(raw));
  const json = JSON.parse((await request("export", "format=json")).body);
  assert.equal(json.messages[0].parts[0].text, raw);
  assert.deepEqual(json.messages[0].parts[0].questionAnswers, messages[0].questionAnswers);
});
