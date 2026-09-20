import assert from "node:assert/strict";
import test from "node:test";

import { initReaderTeams } from "../src/static/app/reader-teams.js";

class Element {
  constructor(dataset = {}, tagName = "div") {
    this.dataset = dataset;
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  replaceWith(...children) {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, ...children);
    for (const child of children) child.parentElement = parent;
    this.parentElement = null;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  get childNodes() { return this.children; }
  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
    if (value.includes("data-reader-team-detail")) {
      const detail = new Element({ readerTeamDetail: "" }, "article");
      const back = new Element({ readerTeamBack: "" }, "button");
      const title = new Element({ readerTeamDetailTitle: "" }, "h4");
      const tasks = new Element({ readerTeamTaskPages: "" }, "ul");
      const taskMore = new Element({}, "li");
      taskMore.classes.add("reader-team-task-more");
      taskMore.append(new Element({ readerTeamTasksMore: "", readerTeamTasksUrl: "/tasks/next" }, "button"));
      tasks.append(taskMore);
      const exchanges = new Element({ readerTeamExchangePages: "" });
      exchanges.append(new Element({ readerTeamExchangesMore: "", readerTeamExchangesUrl: "/exchanges/next" }, "button"));
      detail.append(back, title, tasks, exchanges);
      this.append(detail);
    } else if (value.includes("data-reader-team-exchange-page")) {
      this.append(new Element({ readerTeamExchangePage: "" }));
    } else if (value.includes("data-loaded-task")) {
      this.append(new Element({ loadedTask: "" }, "li"));
    }
  }
  get innerHTML() { return this._innerHTML || ""; }
  matches(selector) {
    if (selector === "*") return true;
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    const attribute = selector.match(/^\[data-([a-z-]+)\]$/)?.[1];
    return attribute ? attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset : false;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(child) { return child === this || this.children.some((candidate) => candidate.contains(child)); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus(options) { this.focusOptions = options; }
  addEventListener(type, callback) { this.listeners.set(type, [...this.listeners.get(type) || [], callback]); }
  dispatchEvent(event) { for (const callback of this.listeners.get(event.type) || []) callback(event); }
}

function harness(t) {
  const workbench = new Element({ sessionReader: "" });
  const pane = new Element({ readerPane: "", readerProvider: "deepseek-harness", readerSession: "root" });
  const team = new Element({ readerTeams: "" });
  const browse = new Element({ readerTeamBrowse: "" });
  const select = new Element({ readerTeamSelect: "member:team:alice", readerTeamDetailUrl: "/detail/alice" }, "button");
  const host = new Element({ readerTeamDetailHost: "" });
  host.hidden = true;
  const status = new Element({ readerTeamStatus: "" });
  browse.append(select);
  team.append(browse, host, status);
  pane.append(team);
  workbench.append(pane);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { querySelector: () => workbench, createElement: (tagName) => new Element({}, tagName) }
  });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "document", descriptor) : delete globalThis.document);
  initReaderTeams();
  const click = (target) => workbench.dispatchEvent({ type: "click", target, preventDefault() {} });
  return { workbench, pane, team, browse, select, host, status, click };
}

test("team selection stays retryable after failure and Back restores the originating focus", async (t) => {
  const h = harness(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? { ok: false, status: 503, json: async () => ({ error: "temporary" }) }
    : { ok: true, status: 200, json: async () => ({
      ok: true,
      selection: { key: "member:team:alice" },
      html: "<article data-reader-team-detail></article>"
    }) });

  h.click(h.select);
  await new Promise(setImmediate);
  assert.equal(h.select.disabled, false);
  assert.equal(h.browse.hidden, false);
  assert.match(h.status.textContent, /temporary/);

  h.click(h.select);
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.equal(h.browse.hidden, true);
  assert.equal(h.host.hidden, false);
  assert.equal(h.select.attributes.get("aria-pressed"), "true");
  const title = h.host.querySelector("[data-reader-team-detail-title]");
  assert.deepEqual(title.focusOptions, { preventScroll: true });

  h.click(h.host.querySelector("[data-reader-team-back]"));
  assert.equal(h.browse.hidden, false);
  assert.equal(h.host.hidden, true);
  assert.deepEqual(h.select.focusOptions, { preventScroll: true });
});

test("team task and exchange continuation replace their controls and append the next server page", async (t) => {
  const h = harness(t);
  const responses = [
    { ok: true, selection: { key: "member:team:alice" }, html: "<article data-reader-team-detail></article>" },
    { ok: true, html: "<div data-reader-team-exchange-page></div>" },
    { ok: true, html: "<li data-loaded-task></li>" }
  ];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => responses.shift() }));
  h.click(h.select);
  await new Promise(setImmediate);

  const exchangePages = h.host.querySelector("[data-reader-team-exchange-pages]");
  h.click(exchangePages.querySelector("[data-reader-team-exchanges-more]"));
  await new Promise(setImmediate);
  assert.equal(exchangePages.querySelector("[data-reader-team-exchanges-more]"), null);
  assert.ok(exchangePages.querySelector("[data-reader-team-exchange-page]"));

  const taskPages = h.host.querySelector("[data-reader-team-task-pages]");
  h.click(taskPages.querySelector("[data-reader-team-tasks-more]"));
  await new Promise(setImmediate);
  assert.equal(taskPages.querySelector("[data-reader-team-tasks-more]"), null);
  assert.ok(taskPages.querySelector("[data-loaded-task]"));
});
