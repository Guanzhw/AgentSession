// Geometry groups close records; all identity, times and source links come from SSR.
export function groupActivityPoints(points, width, gap = 28) {
  const groups = [];
  for (const point of points) {
    const x = point.position / 100 * width;
    const previous = groups.at(-1);
    if (previous && x - previous.lastX < gap) {
      previous.points.push(point);
      previous.lastX = x;
    } else groups.push({ points: [point], lastX: x });
  }
  return groups.map((group) => ({
    points: group.points,
    x: group.points.reduce((sum, point) => sum + point.position / 100 * width, 0) / group.points.length
  }));
}

const requests = new WeakMap();
const selections = new WeakMap();
const clusterRecords = new WeakMap();

function chooseCluster(root, button, records) {
  const selected = new Set(records.map((record) => record.dataset.pointId));
  selections.set(root, selected);
  for (const other of root.querySelectorAll('[data-reader-activity-cluster]')) other.setAttribute('aria-pressed', String(other === button));
  const list = document.createElement('ol');
  for (const record of records) list.append(record.cloneNode(true));
  root.querySelector('[data-reader-activity-selection]').replaceChildren(list);
}

function layoutActivity(root) {
  const selected = selections.get(root) || new Set([root.dataset.readerActivitySelected]);
  root.dataset.activityEnhanced = 'true';
  for (const lane of root.querySelectorAll('[data-reader-activity-lane]')) {
    const track = lane.querySelector('[data-reader-activity-track]');
    const width = track.clientWidth;
    if (!width) continue;
    const focusedId = document.activeElement?.closest('[data-reader-activity-cluster]') === document.activeElement
      && track.contains(document.activeElement) ? clusterRecords.get(document.activeElement)?.[0].dataset.pointId : null;
    for (const button of track.querySelectorAll('[data-reader-activity-cluster]')) button.remove();
    const points = [...lane.querySelector('[data-reader-activity-records]').children]
      .map((record) => ({ position: Number(record.dataset.pointX), record }));
    for (const group of groupActivityPoints(points, width)) {
      const records = group.points.map((point) => point.record);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.readerActivityCluster = '';
      button.dataset.pointKind = records.length === 1 ? records[0].dataset.pointKind : 'cluster';
      button.style.left = `${group.x}px`;
      button.className = 'reader-activity-point';
      button.textContent = records.length > 1 ? String(records.length) : '';
      button.setAttribute('aria-pressed', 'false');
      const label = records.length === 1 ? records[0].dataset.pointLabel
        : `${lane.querySelector('.reader-activity-lane-name').textContent} · ${root.dataset.readerActivityClusterLabel.replace('{count}', String(records.length))}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      clusterRecords.set(button, records);
      track.append(button);
      if (records.some((record) => selected.has(record.dataset.pointId))) chooseCluster(root, button, records);
      if (focusedId && records.some((record) => record.dataset.pointId === focusedId)) button.focus({ preventScroll: true });
    }
  }
}

export async function loadReaderActivity(overview, query = null) {
  const host = overview.querySelector('[data-reader-activity-host]');
  if (!host || (query === null && requests.has(host))) return;
  const params = new URLSearchParams(query || {});
  const token = {};
  requests.set(host, token);
  host.dataset.activityQuery = params.toString();
  const status = host.querySelector('[data-reader-activity-status]');
  const content = host.querySelector('[data-reader-activity-view]');
  const retry = host.querySelector('[data-reader-activity-retry]');
  status.hidden = false;
  status.textContent = host.dataset.loadingLabel;
  content.setAttribute('aria-busy', 'true');
  retry.hidden = true;
  try {
    const response = await fetch(`${host.dataset.readerActivityHost}?${params}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (requests.get(host) !== token) return;
    host.dispatchEvent(new CustomEvent('reader-activity:before-replace', { bubbles: true }));
    content.innerHTML = result.html;
    status.hidden = true;
    const root = content.querySelector('[data-reader-activity-window]');
    if (root) layoutActivity(root);
    host.dispatchEvent(new CustomEvent('reader-activity:loaded', { bubbles: true }));
    return true;
  } catch (error) {
    if (requests.get(host) !== token) return;
    status.textContent = `${host.dataset.errorLabel} (${error.message})`;
    retry.hidden = false;
    return false;
  } finally {
    if (requests.get(host) === token) content.removeAttribute('aria-busy');
  }
}

export function initReaderActivity() {
  const workbench = document.querySelector('.session-workbench[data-session-reader]');
  if (!workbench) return;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) layoutActivity(entry.target);
  });
  workbench.addEventListener('reader-activity:loaded', (event) => {
    const root = event.target.querySelector('[data-reader-activity-window]');
    if (root) observer.observe(root);
  });
  workbench.addEventListener('reader-activity:before-replace', (event) => {
    const root = event.target.querySelector('[data-reader-activity-window]');
    if (root) observer.unobserve(root);
  });
  workbench.addEventListener('session-reader:before-swap', () => observer.disconnect());
  workbench.addEventListener('session-reader:inline-closed', (event) => {
    for (const root of event.detail.pane.querySelectorAll('[data-reader-activity-window]')) observer.unobserve(root);
  });
  workbench.addEventListener('click', (event) => {
    const cluster = event.target.closest('[data-reader-activity-cluster]');
    if (cluster) {
      chooseCluster(cluster.closest('[data-reader-activity-window]'), cluster, clusterRecords.get(cluster));
      return;
    }
    const host = event.target.closest('[data-reader-activity-host]');
    if (!host) return;
    const overview = host.closest('[data-reader-collaboration-overview]');
    const retry = event.target.closest('[data-reader-activity-retry]');
    const navigation = event.target.closest('[data-reader-activity-from]');
    if (retry) {
      // A stale continuation restarts this window against the current source.
      const query = new URLSearchParams(host.dataset.activityQuery);
      query.delete('offset');
      query.delete('revision');
      loadReaderActivity(overview, query).then((loaded) => {
        if (loaded) host.querySelector('.reader-activity-window-nav')?.focus({ preventScroll: true });
      });
    } else if (navigation) {
      const query = { from: navigation.dataset.readerActivityFrom };
      if (navigation.dataset.readerActivityPage) {
        query.offset = navigation.dataset.readerActivityPage;
        query.revision = navigation.dataset.readerActivityRevision;
      }
      loadReaderActivity(overview, query).then((loaded) => {
        if (loaded) host.querySelector('.reader-activity-window-nav')?.focus({ preventScroll: true });
      });
    }
  });
}
