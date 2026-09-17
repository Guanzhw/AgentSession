import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = mkdtempSync(path.join(os.tmpdir(), "agentsession-inherited-source-"));
process.env.AGENTSESSION_META_PATH = path.join(directory, "meta.db");
const { initConfig } = await import("../dist/src/config.js");
initConfig(["--config", path.join(directory, "config.json")]);
const { closeMetaDb } = await import("../dist/src/meta.js");
const { registerSessionDetail } = await import("../dist/src/routes/session-detail.js");
const { renderSessionReaderPane } = await import("../dist/src/views/session.js");
const { renderProgressiveContent } = await import("../dist/src/views/components.js");
const { setLocale } = await import("../dist/src/i18n.js");
test.after(() => { closeMetaDb(); rmSync(directory, { recursive: true, force: true }); });

const retained = "Retained background paragraph. ".repeat(900) + "FINAL_RETAINED_FIELD";
const messages = Array.from({ length: 45 }, (_, index) => ({
  id: `background-${index}`, sessionId: "child", role: "user",
  content: index === 44 ? retained : `COPIED_ONLY ${index}`,
  timestamp: index + 1, thinking: null, toolName: null, toolInput: null,
  toolOutput: null, tokens: null, metadata: { provenance: "inherited-parent-context" }
}));
const view = { sourceSession: null, messages, total: messages.length, truncated: false };

test("unknown-source background is folded and labeled without a fabricated source link or ToC entry", (t) => {
  const render = () => renderSessionReaderPane({ session: { id: "child", title: "Child" }, provider: "fixture", inheritedContext: view });
  const html = render();
  assert.match(html, /<details[^>]*data-inherited-context>/);
  assert.doesNotMatch(html, /<details[^>]*data-inherited-context[^>]*\bopen\b/);
  assert.match(html, /The source session was not recorded\./);
  assert.doesNotMatch(html, /data-reader-open|Open recorded parent session/);
  assert.match(html, /data-part-id="inherited--background-0:text"/);
  assert.match(html, /data-inherited-context-more data-next-offset="40"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('class="inherited-context-disclosure"')), /COPIED_ONLY/);
  setLocale("zh");
  t.after(() => setLocale("en"));
  assert.match(render(), /未记录来源会话。/);
});

test("unknown-source pagination and late-field content share stable IDs and remain outside owned search", async () => {
  const routes = [];
  const provider = {
    id: "fixture", name: "Fixture", icon: "",
    getSession: () => ({ id: "child", title: "Child", timeCreated: 1, timeUpdated: 2 }),
    getMessages: () => [], getInheritedContext: () => view
  };
  registerSessionDetail({ get(pattern, handler) { routes.push({ pattern, handler }); } }, {
    appConfig: { port: 0, metaDir: directory, resumeCommands: {}, allowTerminalLaunch: false },
    providerMap: new Map([["fixture", provider]]), providerInfo: []
  });
  async function request(suffix) {
    const url = `/api/fixture/session/child/${suffix}`;
    const pathname = new URL(url, "http://localhost").pathname;
    const route = routes.find(({ pattern }) => pattern instanceof RegExp && pattern.test(pathname));
    const response = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ url }, response, pathname.match(route.pattern));
    return { status: response.status, body: JSON.parse(response.body) };
  }
  const first = await request("inherited-context?offset=0");
  assert.equal(first.status, 200);
  assert.equal(first.body.nextOffset, 40);
  const last = await request("inherited-context?offset=40");
  assert.equal(last.status, 200);
  assert.equal(last.body.shown, 45);
  assert.equal(last.body.nextOffset, null);
  const ids = [...(first.body.html + last.body.html).matchAll(/id="(inherited-msg-[^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 45);
  assert.equal(new Set(ids).size, 45);
  const part = encodeURIComponent("inherited--background-44:text");
  let offset = 0, pages = 0;
  do {
    const page = await request(`content?scope=inherited-context&part=${part}&field=text&offset=${offset}`);
    assert.equal(page.status, 200);
    const expected = renderProgressiveContent(retained, "markdown", offset, 12000);
    assert.equal(page.body.html, expected.html);
    assert.equal(page.body.nextOffset, expected.nextOffset);
    offset = page.body.nextOffset;
    pages++;
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.equal((await request(`content?scope=owned&part=${part}&field=text&offset=0`)).status, 404);
  assert.equal((await request("search?q=COPIED_ONLY")).body.total, 0);
});
