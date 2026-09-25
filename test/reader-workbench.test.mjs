import assert from "node:assert/strict";
import test from "node:test";
import { initSessionWorkbench } from "../src/static/app/session-workbench.js";

class FakeElement {
  constructor({ tagName = "div", className = "", dataset = {}, id = "" } = {}) {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.dataset = { ...dataset };
    this.id = id;
    this.children = [];
    this._classSet = new Set(className.split(/\s+/).filter(Boolean));
    this.parentElement = null;
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes().add(name)),
      remove: (...names) => names.forEach((name) => this._classes().delete(name)),
      toggle: (name, force) => {
        const classes = this._classes();
        const next = force == null ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: (name) => this._classes().has(name)
    };
  }

  _classes() {
    return this._classSet;
  }

  _setClasses(classes) {
    this._classSet = classes;
    this.className = [...classes].join(" ");
  }

  append(...nodes) {
    nodes.forEach((node) => {
      if (!node || typeof node !== "object") return;
      node.parentElement = this;
      node.parentNode = this;
      this.children.push(node);
    });
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      if (this.parentElement.options) this.parentElement.options.splice(this.parentElement.options.indexOf(this), 1);
    }
    this.parentElement = null;
    this.parentNode = null;
  }

  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }

  get isConnected() {
    let current = this;
    while (current.parentElement) current = current.parentElement;
    return current.dataset?.sessionWorkbench === "true";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "href") this.href = String(value);
    if (name === "value") this.value = String(value);
  }

  getAttribute(name) {
    if (name === "href") return this.href || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    const alternatives = selector.split(",").map((part) => part.trim());
    return alternatives.some((part) => {
      if (part === "*") return true;
      if (part === "[id]") return Boolean(this.id);
      if (part === ":scope > .toc-group-summary > .toc-link") return this.classList.contains("toc-link");
      if (part === "[data-reader-pane]") return this.dataset.readerPane != null;
      if (part === "[data-session-search]") return this.dataset.sessionSearch != null;
      if (part === "[data-session-search-input]") return this.dataset.sessionSearchInput != null;
      if (part === "[data-session-search-status]") return this.dataset.sessionSearchStatus != null;
      if (part === "[data-session-search-previous]") return this.dataset.sessionSearchPrevious != null;
      if (part === "[data-session-search-next]") return this.dataset.sessionSearchNext != null;
      if (part === "[data-session-search-close]") return this.dataset.sessionSearchClose != null;
      if (part === "[data-session-search-scope]") return this.dataset.sessionSearchScope != null;
      if (part === ".session-search-panel") return this.classList.contains("session-search-panel");
      if (part === ".session-toc a[href^='#']") return this.tagName === "A" && this.href?.startsWith("#") && this.closest(".session-toc");
      if (part === ".session-toc .toc-link") return this.classList.contains("toc-link") && this.closest(".session-toc");
      if (part === ".session-toc .toc-group") return this.classList.contains("toc-group") && this.closest(".session-toc");
      if (part === ".toc-group") return this.classList.contains("toc-group");
      if (part === ".toc-link") return this.classList.contains("toc-link");
      if (part === ".toc-group-summary") return this.classList.contains("toc-group-summary");
      if (part === "[data-reader-canonical-anchor]") return this.dataset.readerCanonicalAnchor != null;
      if (part.startsWith("[data-reader-canonical-anchor=\"")) {
        const value = part.match(/="(.*)"\]$/)?.[1];
        return this.dataset.readerCanonicalAnchor === value;
      }
      if (part.startsWith("#")) return this.id === part.slice(1);
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      if (part.startsWith("[data-")) {
        const match = part.match(/^\[data-([\w-]+)\]$/);
        if (!match) return false;
        const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return this.dataset[key] != null;
      }
      return false;
    });
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches(selector)) return current;
      current = current.parentElement;
    }
    return null;
  }

  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  async dispatchEvent(event) {
    for (const callback of this.listeners.get(event.type) || []) await callback(event);
  }

  getBoundingClientRect() {
    return this.rect || { top: 0, bottom: 20 };
  }
}

class FakeSelect extends FakeElement {
  constructor() {
    super({ tagName: "select", dataset: { sessionSearchScope: "true" } });
    this.options = [];
    this._value = "";
  }

  append(...nodes) {
    super.append(...nodes);
    nodes.forEach((node) => this.options.push(node));
  }

  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get selectedOptions() { return this.options.filter((option) => option.value === this._value); }
}

function workbenchHarness(t, { tocSize = 0 } = {}) {
  const original = new Map();
  const install = (name, value) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const workbench = new FakeElement({ dataset: { sessionWorkbench: "true", provider: "fixture", sessionId: "root" } });
  const root = new FakeElement({ dataset: { readerPane: "true", readerProvider: "fixture", readerSession: "root", readerTitle: "Root" } });
  const child = new FakeElement({ dataset: { readerPane: "true", readerProvider: "fixture", readerSession: "child", readerTitle: "Child" } });
  const rootToc = new FakeElement({ className: "session-toc" });
  const childToc = new FakeElement({ className: "session-toc" });
  const rootTarget = new FakeElement({ id: "root-target" });
  const childTarget = new FakeElement({ id: "child-target" });
  rootTarget.rect = { top: 90, bottom: 110 };
  childTarget.rect = { top: 100, bottom: 120 };
  const rootLink = new FakeElement({ tagName: "a", className: "toc-link", id: "root-link" });
  rootLink.href = "#root-target";
  const childLink = new FakeElement({ tagName: "a", className: "toc-link", id: "child-link" });
  childLink.href = "#child-target";
  rootToc.append(rootLink);
  childToc.append(childLink);
  for (let index = 0; index < tocSize; index += 1) {
    const target = new FakeElement({ id: `bulk-target-${index}` });
    target.rect = { top: 4_000 + index * 20, bottom: 4_010 + index * 20 };
    const link = new FakeElement({ tagName: "a", className: "toc-link" });
    link.href = `#bulk-target-${index}`;
    rootToc.append(link);
    root.append(target);
  }
  root.append(rootToc, rootTarget);
  child.append(childToc, childTarget);
  root.append(child);
  const rootQueries = new Map();
  const rootQuerySelectorAll = root.querySelectorAll.bind(root);
  root.querySelectorAll = (selector) => {
    rootQueries.set(selector, (rootQueries.get(selector) || 0) + 1);
    return rootQuerySelectorAll(selector);
  };
  const search = new FakeElement({ dataset: { sessionSearch: "true" } });
  const panel = new FakeElement({ className: "session-search-panel" });
  const scope = new FakeSelect();
  const rootScope = new FakeElement({ tagName: "option", dataset: { readerScopeRoot: "true", readerProvider: "fixture", readerSession: "root" } });
  rootScope.value = "fixture::root";
  scope.append(rootScope);
  const input = new FakeElement({ tagName: "input", dataset: { sessionSearchInput: "true" } });
  input.value = "";
  const status = new FakeElement({ dataset: { sessionSearchStatus: "true" } });
  const previous = new FakeElement({ dataset: { sessionSearchPrevious: "true" } });
  const next = new FakeElement({ dataset: { sessionSearchNext: "true" } });
  const close = new FakeElement({ dataset: { sessionSearchClose: "true" } });
  panel.append(scope, input, status, previous, next, close);
  search.append(panel);
  workbench.append(search, root);
  const window = new FakeElement();
  window.innerHeight = 800;
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.addEventListener = window.addEventListener.bind(window);
  window.requestAnimationFrame = (callback) => callback();
  const document = {
    documentElement: new FakeElement(),
    querySelector: () => workbench,
    createElement: (tagName) => new FakeElement({ tagName }),
    addEventListener: (...args) => workbench.addEventListener(...args)
  };
  const requests = [];
  let pendingChild;
  install("document", document);
  install("window", window);
  install("location", { hash: "" });
  install("history", { pushState() {} });
  install("HTMLElement", FakeElement);
  install("HTMLDetailsElement", FakeElement);
  install("CSS", { escape: (value) => value });
  install("IntersectionObserver", class { observe() {} unobserve() {} });
  install("getComputedStyle", () => ({ getPropertyValue: () => "0" }));
  install("requestAnimationFrame", (callback) => callback());
  install("setTimeout", setTimeout);
  install("clearTimeout", clearTimeout);
  install("fetch", async (url, { signal } = {}) => {
    requests.push({ url, signal });
    if (url.includes("/child/")) {
      if (pendingChild) return pendingChild.promise;
      return { ok: true, json: async () => ({ ok: true, matches: [{ partId: "missing", field: "text", format: "plain", matchIndex: 0 }], offset: 0, total: 9, nextOffset: null }) };
    }
    return { ok: true, json: async () => ({ ok: true, matches: [{ partId: "missing", field: "text", format: "plain", matchIndex: 0 }], offset: 0, total: 1, nextOffset: null }) };
  });
  const ft = (key) => key === "detail.search_results" ? "{current} / {total} matches" : key;
  const formatText = (text, values) => Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text);
  initSessionWorkbench({ ft, formatText });
  const cleanup = () => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
  t.after(cleanup);
  return { workbench, root, child, rootLink, childLink, scope, input, window, requests, rootQueries, setPendingChild(value) { pendingChild = value; } };
}

test("workbench updates active ToC independently for root and inline child scroll", async (t) => {
  const h = workbenchHarness(t);
  await h.window?.dispatchEvent?.({ type: "scroll" });
  assert.equal(h.rootLink.classList.contains("active"), true);
  assert.equal(h.childLink.classList.contains("active"), true);
});

test("large ToC resolves owned anchors in one pane pass rather than once per link", (t) => {
  const h = workbenchHarness(t, { tocSize: 400 });
  assert.equal(h.rootQueries.get("[id], [data-reader-canonical-anchor]"), 1);
  assert.equal(h.rootQueries.get(".session-toc a[href^='#']"), 1);
  assert.equal(h.rootLink.classList.contains("active"), true);
});

test("ToC cache rebuild keeps scoped child anchors and ignores nested-pane targets", async (t) => {
  const h = workbenchHarness(t);
  h.childTarget = h.child.querySelector("#child-target");
  h.childTarget.id = "reader-scope-fixture-child--child-target";
  h.childTarget.dataset.readerCanonicalAnchor = "child-target";
  h.childLink.href = "#reader-scope-fixture-child--child-target";
  const canonicalChildLink = new FakeElement({ tagName: "a", className: "toc-link" });
  canonicalChildLink.href = "#child-target";
  h.child.querySelector(".session-toc").append(canonicalChildLink);
  await h.workbench.dispatchEvent({ type: "session-reader:inline-opened", detail: { pane: h.child } });
  await h.window.dispatchEvent({ type: "scroll" });
  assert.equal(h.childLink.classList.contains("active"), true);
  assert.equal(canonicalChildLink.classList.contains("active"), false, "a canonical alias resolves to the same scoped target without becoming the selected URL");
  const replacement = new FakeElement({ id: "root-replacement" });
  replacement.rect = { top: 85, bottom: 105 };
  h.root.append(replacement);
  h.rootLink.href = "#root-replacement";
  await h.workbench.dispatchEvent({ type: "session-reader:content-updated", detail: { pane: h.root } });
  await h.window.dispatchEvent({ type: "scroll" });
  assert.equal(h.rootLink.classList.contains("active"), true);
});

test("search scope switches request ownership and restores root after closing child", async (t) => {
  const h = workbenchHarness(t);
  h.workbench.dispatchEvent({ type: "session-reader:inline-opened", detail: { pane: h.child } });
  const childOption = h.scope.options.find((option) => option.dataset.readerSession === "child");
  assert.ok(childOption);
  h.scope.value = childOption.value;
  await h.scope.dispatchEvent({ type: "change" });
  let resolveChild;
  h.setPendingChild({ promise: new Promise((resolve) => { resolveChild = resolve; }) });
  h.input.value = "child-query";
  await h.input.dispatchEvent({ type: "input" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(h.requests.some(({ url }) => url.includes("/session/child/search")));
  h.scope.value = "fixture::root";
  await h.scope.dispatchEvent({ type: "change" });
  h.input.value = "root-query";
  await h.input.dispatchEvent({ type: "input" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(h.workbench.querySelector("[data-session-search-status]").textContent, /0 \/ 1 matches/);
  resolveChild({ ok: true, json: async () => ({ ok: true, matches: [{ partId: "missing", field: "text", format: "plain", matchIndex: 0 }], offset: 0, total: 9, nextOffset: null }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.workbench.querySelector("[data-session-search-status]").textContent, /0 \/ 1 matches/, "stale child results must not replace the root scope");
  h.child.remove();
  await h.workbench.dispatchEvent({ type: "session-reader:inline-closed", detail: { pane: h.child } });
  assert.equal(h.scope.selectedOptions[0]?.dataset.readerScopeRoot, "true");
  assert.equal(h.input.value, "root-query");
});
