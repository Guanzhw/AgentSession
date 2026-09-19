import assert from 'node:assert/strict';
import test from 'node:test';
import { focusReaderTaskGraph, initReaderTaskGraphs, replaceReaderTaskGraph } from '../src/static/app/reader-task-graph.js';

function fixture() {
  const pages = Array.from({ length: 3 }, (_, index) => ({ dataset: { readerTaskGraphPage: String(index) }, hidden: index !== 0 }));
  const nodes = Array.from({ length: 9 }, (_, index) => ({
    dataset: { readerTaskSelect: `run:${index}` },
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    closest() { return pages[Math.floor(index / 4)]; }
  }));
  const edges = nodes.map((node) => ({ dataset: { readerGraphEdge: node.dataset.readerTaskSelect }, selected: false,
    classList: { toggle(_name, value) { this.owner.selected = value; } }
  }));
  for (const edge of edges) edge.classList.owner = edge;
  const label = {};
  const previous = { disabled: true };
  const next = { disabled: false };
  const graph = {
    dataset: { readerGraphPage: '0' },
    querySelector(selector) {
      return { '[data-reader-graph-page-label]': label, '[data-reader-graph-previous]': previous, '[data-reader-graph-next]': next }[selector];
    },
    querySelectorAll(selector) {
      return { '[data-reader-task-graph-page]': pages, '[data-reader-task-select]': nodes, '[data-reader-graph-edge]': edges }[selector];
    }
  };
  const root = { querySelector() { return graph; }, addEventListener(_event, callback) { this.click = callback; } };
  return { root, graph, pages, nodes, edges, label, previous, next };
}

test('graph selection reveals the matching group and highlights the same canonical relationship', () => {
  const f = fixture();
  focusReaderTaskGraph(f.root, 'run:8');
  assert.deepEqual(f.pages.map((page) => page.hidden), [true, true, false]);
  assert.equal(f.label.textContent, '3 / 3');
  assert.equal(f.next.disabled, true);
  assert.equal(f.previous.disabled, false);
  assert.equal(f.nodes[8].attributes['aria-pressed'], 'true');
  assert.equal(f.edges.filter((edge) => edge.selected).length, 1);
  assert.equal(f.edges[8].selected, true);
});

test('graph controls move between bounded visual groups without loading or changing task content', () => {
  const f = fixture();
  initReaderTaskGraphs(f.root);
  const button = { closest() { return f.graph; }, hasAttribute(name) { return name === 'data-reader-graph-next'; } };
  f.root.click({ target: { closest() { return button; } } });
  assert.equal(f.graph.dataset.readerGraphPage, '1');
  assert.deepEqual(f.pages.map((page) => page.hidden), [true, false, true]);
  assert.equal(f.label.textContent, '2 / 3');
  assert.equal(f.nodes.every((node) => Object.keys(node.attributes).length === 0), true);
});

test('selecting a task whose other relationships share an earlier window keeps the current window', () => {
  const f = fixture();
  f.nodes[8].dataset.readerTaskSelect = 'run:0';
  f.pages.forEach((page, index) => { page.hidden = index !== 2; });
  f.graph.dataset.readerGraphPage = '2';
  focusReaderTaskGraph(f.root, 'run:0');
  assert.equal(f.graph.dataset.readerGraphPage, '2');
  assert.equal(f.nodes[0].attributes['aria-pressed'], 'true');
  assert.equal(f.nodes[8].attributes['aria-pressed'], 'true');
});

test('selecting an earlier task restores its original graph after a late task was loaded', () => {
  const first = fixture();
  const late = fixture();
  late.nodes.forEach((node, index) => { node.dataset.readerTaskSelect = `run:late-${index}`; });
  late.edges.forEach((edge, index) => { edge.dataset.readerGraphEdge = `run:late-${index}`; });
  let current = first.graph;
  const host = {
    querySelector() { return current; },
    set innerHTML(_html) { current = late.graph; },
    replaceChildren(node) { current = node; }
  };
  const root = { querySelector(selector) { return selector === '[data-reader-task-graph-host]' ? host : current; } };
  replaceReaderTaskGraph(host, 'server-rendered late graph');
  assert.equal(current, late.graph);
  focusReaderTaskGraph(root, 'run:5');
  assert.equal(current, first.graph);
  assert.equal(first.nodes[5].attributes['aria-pressed'], 'true');
  focusReaderTaskGraph(root, 'run:late-1');
  assert.equal(current, late.graph);
  assert.equal(late.nodes[1].attributes['aria-pressed'], 'true');
});
