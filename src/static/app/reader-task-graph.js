/** Relationship meaning is server-rendered; the browser only changes its window and focus. */
const graphVariants = new WeakMap();

export function replaceReaderTaskGraph(host, html) {
  const variants = graphVariants.get(host) || new Set();
  const current = host.querySelector('[data-reader-task-graph]');
  if (current) variants.add(current);
  host.innerHTML = html;
  const replacement = host.querySelector('[data-reader-task-graph]');
  if (replacement) variants.add(replacement);
  graphVariants.set(host, variants);
}

export function focusReaderTaskGraph(root, key) {
  let graph = root.querySelector('[data-reader-task-graph]');
  const host = root.querySelector('[data-reader-task-graph-host]');
  const containsTask = (candidate) => [...candidate.querySelectorAll('[data-reader-task-select]')].some((node) => node.dataset.readerTaskSelect === key);
  if (host && (!graph || !containsTask(graph))) {
    const saved = [...(graphVariants.get(host) || [])].find(containsTask);
    if (saved) {
      host.replaceChildren(saved);
      graph = saved;
    }
  }
  if (!graph) return;
  const candidates = [...graph.querySelectorAll('[data-reader-task-select]')]
    .filter((node) => node.dataset.readerTaskSelect === key);
  const selected = candidates.find((node) => !node.closest('[data-reader-task-graph-page]').hidden) || candidates[0];
  if (selected) showPage(graph, Number(selected.closest('[data-reader-task-graph-page]').dataset.readerTaskGraphPage));
  for (const node of graph.querySelectorAll('[data-reader-task-select]')) node.setAttribute('aria-pressed', String(node.dataset.readerTaskSelect === key));
  for (const edge of graph.querySelectorAll('[data-reader-graph-edge]')) edge.classList.toggle('reader-task-graph-edge-selected', edge.dataset.readerGraphEdge === key);
}

function showPage(graph, index) {
  const pages = [...graph.querySelectorAll('[data-reader-task-graph-page]')];
  const page = Math.max(0, Math.min(pages.length - 1, index));
  graph.dataset.readerGraphPage = String(page);
  for (const canvas of pages) canvas.hidden = Number(canvas.dataset.readerTaskGraphPage) !== page;
  const label = graph.querySelector('[data-reader-graph-page-label]');
  if (label) label.textContent = `${page + 1} / ${pages.length}`;
  const previous = graph.querySelector('[data-reader-graph-previous]');
  const next = graph.querySelector('[data-reader-graph-next]');
  if (previous) previous.disabled = page === 0;
  if (next) next.disabled = page + 1 === pages.length;
}

export function initReaderTaskGraphs(workbench) {
  workbench.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reader-graph-previous], [data-reader-graph-next]');
    if (!button) return;
    const graph = button.closest('[data-reader-task-graph]');
    showPage(graph, Number(graph.dataset.readerGraphPage) + (button.hasAttribute('data-reader-graph-next') ? 1 : -1));
  });
}
