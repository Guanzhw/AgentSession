import assert from "node:assert/strict";
import test from "node:test";

const { renderSessionPage, renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { buildMessageSessionTree } = await import("../dist/src/providers/shared/message-session.js");
const { setLocale } = await import("../dist/src/i18n.js");

function message(id, content, phase, role = "assistant") {
  return { id, sessionId: "child", role, content, presentationPhase: phase, timestamp: 1,
    metadata: { turnId: id } };
}

function childTree(messages, provider = "fixture", sessionId = "child") {
  return buildMessageSessionTree({ id: sessionId, title: "Child title", provider },
    messages.map((item) => ({ ...item, sessionId })));
}

function card(overrides = {}) {
  return {
    id: "run:first", name: "worker", actorKind: "agent", responsibility: "Review the implementation",
    state: "active", rawStatus: "in_progress", interrupted: false, lastActivity: 2,
    observationCount: 1, channelTruncated: false, channelNextCursor: null,
    channel: [{ id: "dispatch", kind: "spawn", state: "started", timestamp: 1,
      senderName: null, recipientName: "worker", eventId: "event:dispatch", turnId: null,
      sourceEventRef: null }],
    childSession: { provider: "fixture", sessionId: "child" }, childSessionAvailable: true,
    bindings: { taskToolCallId: null, childSessionId: "child", turnId: null, actorIds: [] },
    ...overrides
  };
}

function readerInput(children, cards = [card()]) {
  const tree = buildMessageSessionTree({ id: "root", title: "Root" }, [
    { id: "root-message", sessionId: "root", role: "assistant", content: "Root-owned reply", timestamp: 1 }
  ]);
  tree.detachedChildren = children;
  return { session: tree.session, sessionTree: tree, provider: "fixture",
    conversationView: { cards, references: [], inspector: null, turnBoundaries: [] } };
}

function rail(html) {
  return html.match(/<aside class="reader-collaboration"[\s\S]*?<\/aside>/)?.[0] || "";
}

function branches(html) {
  const output = [];
  let depth = 0;
  let start = -1;
  const markup = rail(html);
  for (const match of markup.matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0].startsWith('<details')) {
      if (start === -1 && match[0].includes('class="reader-branch"')) start = match.index;
      if (start !== -1) depth += 1;
    } else if (start !== -1 && --depth === 0) {
      output.push(markup.slice(start, match.index + match[0].length));
      start = -1;
    }
  }
  return output;
}

test("branch renders one lazy preview target despite later commentary", () => {
  const child = childTree([
    message("first-final", "Previous final reply", "final"),
    message("last-final", "Current final reply", "final"),
    message("later-progress", "Later progress update", "commentary")
  ]);
  const html = renderSessionReaderPane(readerInput([child]));
  const [branch] = branches(html);
  assert.match(branch, /class="reader-task-preview" data-reader-task-preview data-reader-provider="fixture" data-reader-session="child"/);
  assert.match(branch, /data-reader-preview-content/);
  assert.doesNotMatch(branch, /Previous final reply|Current final reply|Later progress update/);
  assert.match(branch, /title="Recorded state">active/);
  assert.doesNotMatch(branch, /state: completed|in_progress/);
  assert.match(branch, /Review the implementation/);
  assert.match(branch, /data-reader-task-lane=[\s\S]*data-channel-id="dispatch"[\s\S]*data-reader-event-id="event:dispatch"/);
  assert.doesNotMatch(rail(html), /reader-task-details/);
  assert.doesNotMatch(rail(html), /data-reader-time-axis|reader-timeline-legend|reader-time-lane/);
  assert.doesNotMatch(branch.match(/<details[^>]*>/)[0], /\sopen(?:\s|>)/);
});

test("phase-less and commentary-only replies retain one lazy preview target", () => {
  for (const phase of [undefined, "commentary"]) {
    const child = childTree([
      message("earlier", "Earlier reply", phase),
      message("latest", "Latest available prose", phase),
      message("blank", " \n\t ", "final")
    ]);
    const [branch] = branches(renderSessionReaderPane(readerInput([child])));
    assert.equal((branch.match(/data-reader-task-preview/g) || []).length, 1);
    assert.match(branch, /data-reader-preview-status/);
    assert.doesNotMatch(branch, /Latest available prose|Earlier reply/);
  }
});

test("lazy branch preview excludes eager child, role, and nested history bodies", () => {
  const child = childTree([
    message("own", "Child-owned answer", undefined),
    message("user", "User text must stay out", "final", "user"),
    { ...message("tool", "Tool text must stay out", "final", "tool"), toolName: "run", toolOutput: "Tool output must stay out" },
    { ...message("reasoning", "", "final"), thinking: "Reasoning must stay out" }
  ]);
  const grandchild = childTree([message("grandchild-final", "Grandchild final must stay out", "final")], "fixture", "grandchild");
  child.messages[0].parts[0].childSessions = [grandchild];
  child.detachedChildren = [grandchild];
  const input = readerInput([child]);
  input.inheritedContext = {
    sourceSession: { provider: "fixture", sessionId: "ancestor" },
    messages: [message("inherited-final", "Inherited final must stay out", "final")]
  };
  const [branch] = branches(renderSessionReaderPane(input));
  assert.match(branch, /data-reader-task-preview/);
  assert.doesNotMatch(branch, /Child-owned answer|User text|Tool text|Tool output|Reasoning|Grandchild final|Inherited final/);
});

test("empty branches preserve their recorded task and state beside lazy preview", () => {
  const child = childTree([
    message("user", "Only user text", undefined, "user"),
    { ...message("reasoning", "", "final"), thinking: "Only reasoning" },
    message("empty", " \n ", "final")
  ]);
  const [branch] = branches(renderSessionReaderPane(readerInput([child])));
  assert.match(branch, /data-reader-task-preview/);
  assert.doesNotMatch(branch, /data-reader-branch-excerpt|Only user text|Only reasoning/);
  assert.match(branch, /Review the implementation/);
  assert.match(branch, /title="Recorded state">active/);
  assert.match(branch, /data-reader-open/);
});

test("known unavailable child is explained in the selected task", () => {
  const [branch] = branches(renderSessionReaderPane(readerInput([], [card({ childSessionAvailable: false })])));
  assert.match(branch, /Child session unavailable/);
  assert.doesNotMatch(branch, /data-reader-task-preview|data-reader-open/);
});

test("multiple run cards share one lazy preview target and retain separate run states", () => {
  const child = childTree([message("final", "One child final", "final")]);
  const input = readerInput([child], [
    card({ state: "completed", responsibility: "First assignment" }),
    card({ id: "run:second", state: "active", responsibility: "Follow-up assignment" })
  ]);
  const output = branches(renderSessionReaderPane(input));
  assert.equal(output.length, 1);
  const [branch] = output;
  assert.equal((branch.match(/data-reader-task-preview/g) || []).length, 1);
  assert.match(branch, /data-reader-open data-reader-provider="fixture" data-reader-session="child"/);
  assert.match(branch, /data-reader-branch-run="run:first"[\s\S]*First assignment[\s\S]*Recorded state: completed/);
  assert.match(branch, /data-reader-branch-run="run:second"[\s\S]*Follow-up assignment[\s\S]*Recorded state: active/);
  assert.doesNotMatch(branch, /One child final/);
});

test("one canonical task contains distinct followups and returns with owning source and paging", () => {
  const channel = (id, kind, owner = 'root') => ({ ...card().channel[0], id, kind,
    eventId: `event:${id}`, sourceEventRef: { session: { provider: 'fixture', sessionId: owner }, eventId: `event:${id}` } });
  const input = readerInput([], [
    card({ channel: [channel('followup-1', 'follow-up'), channel('return-1', 'child-completion', 'child')],
      channelTruncated: true, channelNextCursor: 'cursor:next' }),
    card({ id: 'run:second', channel: [channel('followup-2', 'follow-up'), channel('return-2', 'result-delivery')] })
  ]);
  input.readerRelations = { lanes: [{ id: 'canonical-child', childSession: { provider: 'fixture', sessionId: 'child' }, runIds: ['first', 'second'] }], milestones: [], unplaced: [] };
  const output = branches(renderSessionReaderPane(input));
  assert.equal(output.length, 1);
  const [branch] = output;
  assert.match(branch, /data-reader-task-lane="canonical-child"/);
  for (const id of ['followup-1', 'return-1', 'followup-2', 'return-2']) {
    assert.equal((branch.match(new RegExp(`data-reader-event-id="event:${id}"`, 'g')) || []).length, 1);
  }
  assert.match(branch, /data-reader-session="child" data-reader-event-id="event:return-1"/);
  assert.match(branch, /reader\/coordination\?size=50&amp;runId=first&amp;cursor=cursor%3Anext/);
  const channels = [...branch.matchAll(/<section[^>]*data-agent-channel[^>]*>/g)].map((match) => match[0]);
  assert.equal(channels.length, 2);
  const exchanges = [...branch.matchAll(/<details[^>]*data-reader-coordination-content[^>]*>/g)].map((match) => match[0]);
  assert.equal(exchanges.length, 4);
  exchanges.forEach((openingTag) => assert.doesNotMatch(openingTag, /\sopen(?:\s|>)/));
  assert.ok(branch.indexOf('data-agent-channel') < branch.indexOf('class="reader-task-overview"'));
});

test("canonical branch identity includes provider and uses attached as well as detached children", () => {
  const detached = childTree([message("detached", "Detached provider reply", "final")]);
  const attached = childTree([message("attached", "Attached provider reply", "final")], "other-provider");
  const input = readerInput([detached], [card(), card({ id: "run:other", childSession: { provider: "other-provider", sessionId: "child" } })]);
  input.sessionTree.messages[0].parts[0].childSessions = [attached];
  const output = branches(renderSessionReaderPane(input));
  assert.equal(output.length, 2);
  assert.match(output[0], /data-reader-branch-provider="fixture"[\s\S]*data-reader-task-preview/);
  assert.match(output[1], /data-reader-branch-provider="other-provider"[\s\S]*data-reader-task-preview/);
});

test("only consecutive routine messages fold between visible task milestones", () => {
  const kinds = ['spawn', 'message', 'message', 'follow-up', 'message', 'message', 'result-delivery'];
  const input = readerInput([], [card({ channel: kinds.map((kind, index) => ({ ...card().channel[0],
    id: `item-${index}`, eventId: `event:${index}`, kind, state: 'unknown' })) })]);
  const [branch] = branches(renderSessionReaderPane(input));
  assert.equal((branch.match(/class="reader-channel-group"/g) || []).length, 2);
  assert.equal((branch.match(/2 messages · expand/g) || []).length, 2);
  assert.equal((branch.match(/data-channel-id=/g) || []).length, 7);
  assert.match(branch, /data-channel-kind="spawn"[\s\S]*reader-channel-group[\s\S]*data-channel-kind="follow-up"[\s\S]*reader-channel-group[\s\S]*data-channel-kind="result-delivery"/);
  assert.doesNotMatch(branch, /agent-channel-state">unknown/);
  assert.ok(branch.indexOf('data-reader-open') < branch.indexOf('data-agent-channel'), 'Full history remains discoverable above the record sequence');
});

test("lazy branches retain canonical child identity for bounded preview loading", () => {
  const child = childTree([message("reply:/source?!", "reply", "final")], "fixture", "child:/punctuation");
  const input = readerInput([child], [card({ childSession: { provider: "fixture", sessionId: child.session.id } })]);
  const [branch] = branches(renderSessionReaderPane(input));
  assert.match(branch, /data-reader-task-preview data-reader-provider="fixture" data-reader-session="child:\/punctuation"/);
  assert.doesNotMatch(branch, /reply<\/blockquote>/);
});

test("initial page and lazy reader fragment render one preview target in both locales", () => {
  const input = readerInput([childTree([message("final", "Readable child reply", "final")])]);
  try {
    for (const locale of ["en", "zh"]) {
      setLocale(locale);
      const pane = renderSessionReaderPane(input);
      const page = renderSessionPage(input);
      assert.equal(rail(page), rail(pane));
      assert.equal((rail(pane).match(/data-reader-task-preview/g) || []).length, 1);
      assert.match(rail(pane), locale === "zh" ? /分派任务/ : /Task assigned/);
    }
  } finally {
    setLocale("en");
  }
});
