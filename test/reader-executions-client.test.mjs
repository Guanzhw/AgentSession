import assert from "node:assert/strict";
import test from "node:test";
import { initReaderExecutions, loadReaderExecution, executionBracketSlots } from "../src/static/app/reader-executions.js";

test("nonconsecutive asynchronous occurrences have distinct stable bracket slots", () => {
  const initial = executionBracketSlots(["run-0", "run-4", "run-8", "run-12"]);
  assert.equal(new Set(initial.values()).size, 4);
  const promoted = executionBracketSlots(["run-16", "run-0", "run-4", "run-8", "run-12"], initial);
  assert.equal(promoted.size, 4);
  assert.equal(new Set(promoted.values()).size, 4);
  for (const id of ["run-0", "run-4", "run-8"]) assert.equal(promoted.get(id), initial.get(id));
  assert.equal(promoted.get("run-16"), initial.get("run-12"));
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const response = (html) => ({ ok: true, json: async () => ({ ok: true, html }) });

class Element {
  constructor(dataset = {}, tagName = "div") {
    this.dataset = dataset;
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.parentElement = null;
    this.disabled = false;
    this.textContent = "";
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  replaceWith(...children) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, ...children);
    children.forEach((child) => { child.parentElement = parent; });
    this.parentElement = null;
  }

  get childNodes() { return this.children; }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
    if (value === "initial") {
      const steps = new Element({ readerExecutionSteps: "" }, "ol");
      const step = new Element({ readerExecutionStep: "initial" }, "li");
      step.id = "execution-step";
      steps.append(step);
      const row = new Element({}, "li");
      const more = new Element({ readerExecutionMore: "", readerExecutionCursor: "next" }, "button");
      row.append(more);
      steps.append(row);
      this.append(steps);
    } else if (value === "more") {
      const step = new Element({ readerExecutionStep: "more" }, "li");
      step.id = "later-step";
      this.append(step);
    } else if (value === "fragment") {
      const step = new Element({ readerExecutionStep: "fragment" }, "li");
      step.id = "fragment-step";
      step.setAttribute("href", "#existing-source");
      this.append(step);
    }
  }

  get innerHTML() { return this._innerHTML || ""; }

  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
    if (selector === "*") return true;
    if (selector === this.tagName) return true;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const match = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!match) return false;
    const key = match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return key in this.dataset && (match[2] === undefined || this.dataset[key] === match[2]);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }

  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) || null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) {
    const data = name.match(/^data-([a-z-]+)$/);
    if (data) return data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in this.dataset;
    return this.attributes.has(name);
  }
}

function executionHarness(t) {
  const pane = new Element({ readerPane: "", readerDomScope: "reader-scope-fixture" });
  const detail = new Element({ readerExecutionDetail: "", readerExecutionUrl: "/api/fixture/execution" }, "details");
  const panel = new Element({ readerExecutionPanel: "" });
  const status = new Element({ readerExecutionStatus: "" });
  const source = new Element({}, "p");
  source.id = "reader-scope-fixture--existing-source";
  source.dataset.readerCanonicalAnchor = "existing-source";
  source.textContent = "Recorded source stays in the reader.";
  detail.append(panel, status, source);
  pane.append(detail);
  const workbenchListeners = new Map();
  const workbench = {
    querySelectorAll() { return []; },
    addEventListener(type, listener) { workbenchListeners.set(type, listener); },
    dispatchEvent(event) { workbenchListeners.get(event.type)?.(event); }
  };
  const requests = [];
  const globals = {
    ResizeObserver: class { observe() {} unobserve() {} },
    requestAnimationFrame: () => 1,
    window: { addEventListener() {} },
    location: { href: "http://localhost/reader" },
    CSS: { escape: (value) => String(value) },
    fetch(url, options) {
      const request = deferred();
      requests.push({ url: String(url), options, ...request });
      return request.promise;
    },
    document: {
      querySelector: () => workbench,
      createElement: (tag) => new Element({}, tag)
    }
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  return { pane, detail, panel, status, source, requests, workbench, workbenchListeners };
}

test("initial execution loading is singleflight, preserves recorded reader content, and scopes only fresh markup", async (t) => {
  const h = executionHarness(t);
  const first = loadReaderExecution(h.detail);
  const duplicate = loadReaderExecution(h.detail);
  assert.equal(first, duplicate);
  assert.equal(h.requests.length, 1);
  assert.equal(h.status.textContent, "Loading execution…");
  assert.equal(h.detail.attributes.get("aria-busy"), "true");
  h.requests[0].resolve(response("fragment"));
  assert.equal(await first, true);

  const fragment = h.panel.querySelector('[data-reader-execution-step="fragment"]') || h.panel.querySelector("[data-reader-execution-step]");
  assert.equal(fragment.id, "reader-scope-fixture--fragment-step");
  assert.equal(fragment.dataset.readerCanonicalAnchor, "fragment-step");
  assert.equal(fragment.getAttribute("href"), "#reader-scope-fixture--existing-source");
  assert.equal(h.source.id, "reader-scope-fixture--existing-source", "previous reader content is not rescaled or replaced");
  assert.equal(h.source.textContent, "Recorded source stays in the reader.");
  assert.equal(h.detail.dataset.readerExecutionLoaded, "true");
  assert.equal(h.status.textContent, "");
  assert.equal(h.detail.attributes.has("aria-busy"), false);
});

test("more appends to the existing execution steps and removes only its consumed cursor", async (t) => {
  const h = executionHarness(t);
  const initial = loadReaderExecution(h.detail);
  h.requests[0].resolve(response("initial"));
  await initial;
  const steps = h.panel.querySelector("[data-reader-execution-steps]");
  const initialStep = steps.querySelector("[data-reader-execution-step]");
  const more = h.panel.querySelector("[data-reader-execution-more]");
  const moreRow = more.closest("li");

  const next = loadReaderExecution(h.detail, "next");
  assert.equal(h.requests.length, 2);
  assert.equal(more.disabled, true);
  h.requests[1].resolve(response("more"));
  assert.equal(await next, true);
  assert.equal(steps.querySelector("[data-reader-execution-step]"), initialStep);
  assert.equal(steps.querySelectorAll("[data-reader-execution-step]").length, 2);
  assert.equal(h.panel.querySelector("[data-reader-execution-more]"), null);
  assert.equal(moreRow.parentElement, null);
  assert.equal(more.disabled, false);
});

test("open and duplicate more requests do not reload an execution already loading or loaded", async (t) => {
  const h = executionHarness(t);
  initReaderExecutions();
  h.detail.open = true;
  h.workbench.dispatchEvent({ type: "toggle", target: h.detail });
  h.workbench.dispatchEvent({ type: "toggle", target: h.detail });
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(response("initial"));
  await new Promise(setImmediate);
  h.workbench.dispatchEvent({ type: "toggle", target: h.detail });
  assert.equal(h.requests.length, 1, "reopening a loaded detail stays local");
});

test("failed cursor load exposes retry and a stale cursor retry restarts the execution at page one", async (t) => {
  const h = executionHarness(t);
  initReaderExecutions();
  const initial = loadReaderExecution(h.detail);
  h.requests[0].resolve(response("initial"));
  await initial;
  const more = h.panel.querySelector("[data-reader-execution-more]");
  h.workbench.dispatchEvent({ type: "click", target: more });
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ ok: false, status: 409, json: async () => ({ ok: false, code: "stale_page" }) });
  await new Promise(setImmediate);
  assert.equal(h.status.textContent, "Earlier steps changed. Reload this execution. ");
  const retry = h.status.querySelector("[data-reader-execution-retry]");
  assert.ok(retry);
  assert.equal(retry.dataset.readerExecutionRetry, "");
  assert.equal(more.disabled, false);

  h.workbench.dispatchEvent({ type: "click", target: retry });
  assert.equal(h.requests.length, 3);
  assert.equal(new URL(h.requests[2].url).searchParams.has("cursor"), false);
  h.requests[2].resolve(response("fragment"));
  await new Promise(setImmediate);
  assert.equal(h.detail.dataset.readerExecutionLoaded, "true");
  assert.equal(h.status.textContent, "");
});

test("ordinary execution load failure keeps a cursor-specific retry", async (t) => {
  const h = executionHarness(t);
  const failed = loadReaderExecution(h.detail, "later-page");
  h.requests[0].reject(new Error("network"));
  assert.equal(await failed, false);
  assert.equal(h.status.textContent, "Execution could not be loaded. ");
  const retry = h.status.querySelector("[data-reader-execution-retry]");
  assert.equal(retry.dataset.readerExecutionRetry, "later-page");
  assert.equal(h.detail.attributes.has("aria-busy"), false);
});
