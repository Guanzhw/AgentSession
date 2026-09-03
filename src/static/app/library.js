// UI v2 P1 library interactions: day-bucketed timeline default with a
// compact-list toggle persisted in localStorage, plus j/k row movement.
// Server-rendered markup stays complete; this only re-buckets the same rows.
export function initLibrary({ ft }) {
  const list = document.getElementById("session-list");
  if (!list) return;

  const VIEW_KEY = "as.library.view";
  let view = "timeline";

  try {
    view = localStorage.getItem(VIEW_KEY) === "compact" ? "compact" : "timeline";
  } catch {
    view = "timeline";
  }

  function dayKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function dayLabel(day) {
    if (day === "unknown") return ft("timeline_unknown");
    const today = dayKey(new Date());
    const yesterday = dayKey(new Date(Date.now() - 86400000));
    if (day === today) return ft("timeline_today");
    if (day === yesterday) return ft("timeline_yesterday");
    const [year, month, date] = day.split("-").map(Number);
    return new Date(year, month - 1, date).toLocaleDateString(document.documentElement.lang || undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric"
    });
  }

  function renderList() {
    const cards = [...list.querySelectorAll(".session-card")];
    const fragment = document.createDocumentFragment();
    if (view === "timeline") {
      let currentDay = null;
      let group = null;
      let count = 0;
      for (const card of cards) {
        const day = card.dataset.day || "unknown";
        if (day !== currentDay || !group) {
          currentDay = day;
          group = document.createElement("section");
          group.className = "library-day";
          group.dataset.day = day;
          const header = document.createElement("header");
          header.className = "library-day-heading";
          const heading = document.createElement("h2");
          heading.textContent = dayLabel(day);
          const countSpan = document.createElement("span");
          countSpan.className = "library-day-count";
          header.append(heading, countSpan);
          group.append(header);
          fragment.append(group);
          count = 0;
        }
        count += 1;
        group.querySelector(".library-day-count").textContent = String(count);
        group.append(card);
      }
    } else {
      for (const card of cards) fragment.append(card);
    }
    list.replaceChildren(fragment);
    list.dataset.view = view;
  }

  function setView(next) {
    view = next === "compact" ? "compact" : "timeline";
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Preference persistence is best-effort; the view still switches.
    }
    const buttons = [...document.querySelectorAll(".library-view-toggle [data-view]")];
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
    }
    renderList();
  }

  const buttons = [...document.querySelectorAll(".library-view-toggle [data-view]")];
  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  renderList();

  // Re-bucket rows appended by infinite scroll.
  window.__libraryRegroup = renderList;

  // j/k move focus through the session rows when the library list is present.
  document.addEventListener("keydown", (event) => {
    if ((event.key !== "j" && event.key !== "k") || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) {
      return;
    }
    const links = [...list.querySelectorAll(".session-card-title-link")];
    if (!links.length) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement);
    const next = event.key === "j" ? Math.min(current + 1, links.length - 1) : Math.max(current - 1, 0);
    const link = links[Math.max(0, next)];
    link.focus();
    link.scrollIntoView({ block: "nearest" });
  });
}
