export function initEnhancements({ ft, formatText, showToast, escapeHtmlClient }) {
// ── Tab bar navigation ──────────────────────────────────────────────

(function initTabBar() {
  const tabBar = document.querySelector(".tab-bar");
  if (!tabBar) return;

  // Enable tabs: show tab bar, hide inactive panels
  tabBar.removeAttribute("hidden");
  const tabButtons = tabBar.querySelectorAll("[role='tab']");
  // Only manage the session workbench's top-level panels. Runtime lenses are
  // nested tabpanels with their own controller and must retain their state.
  const tabPanels = tabBar.parentElement?.querySelectorAll(":scope > [role='tabpanel']") || [];

  const initiallySelected = tabBar.querySelector("[role='tab'][aria-selected='true']") || tabButtons[0];

  // JavaScript progressively enhances the no-JS stacked content into tabs.
  tabPanels.forEach(function (panel) {
    if (panel.id === initiallySelected?.getAttribute("aria-controls")) {
      panel.removeAttribute("hidden");
    } else {
      panel.setAttribute("hidden", "");
    }
  });

  function switchTab(tabButton) {
    // Deactivate all tabs
    tabButtons.forEach(function (btn) {
      btn.setAttribute("aria-selected", "false");
      btn.setAttribute("tabindex", "-1");
    });
    // Activate selected tab
    tabButton.setAttribute("aria-selected", "true");
    tabButton.setAttribute("tabindex", "0");
    tabButton.focus();
    const targetPanelId = tabButton.getAttribute("aria-controls");
    document.querySelector(".session-workbench")?.classList.toggle("session-conversation-tab-active", targetPanelId === "tab-conversation");
    // Show/hide panels
    tabPanels.forEach(function (panel) {
      if (panel.id === targetPanelId) {
        panel.removeAttribute("hidden");
      } else {
        panel.setAttribute("hidden", "");
      }
    });
    if (targetPanelId === "tab-runtime") {
      // The conversation panel can leave the Runtime controls beneath the
      // fixed topbar. Reveal first, then align the runtime header without
      // stealing focus from the selected tab (including keyboard users).
      requestAnimationFrame(function () {
        document.querySelector("[data-runtime-root]")?.scrollIntoView({ block: "start", behavior: "instant" });
      });
    }
  }

  // Click handler
  tabBar.addEventListener("click", function (e) {
    var tab = e.target.closest("[role='tab']");
    if (!tab) return;
    e.preventDefault();
    switchTab(tab);
  });

  // Keyboard navigation: roving tabindex
  tabBar.addEventListener("keydown", function (e) {
    var tabs = Array.from(tabBar.querySelectorAll("[role='tab']"));
    var current = document.activeElement;
    var currentIndex = tabs.indexOf(current);
    if (currentIndex === -1) return;

    var nextIndex = currentIndex;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (e.key === "Home") {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === "End") {
      e.preventDefault();
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    tabs[nextIndex].focus();
    switchTab(tabs[nextIndex]);
  });

  document.querySelector(".session-workbench")?.classList.toggle("session-conversation-tab-active", initiallySelected?.getAttribute("aria-controls") === "tab-conversation");
})();

// ── Token Explorer interactivity ───────────────────────────────────────

(function initTokenExplorer() {
  if (document.body.dataset.page !== "stats") return;

  const statsForm = document.querySelector(".stats-filter-bar");
  const customDates = document.querySelector(".stats-filter-custom-dates");
  const customRadio = document.querySelector(".stats-preset-radio[value='custom']");

  if (statsForm) {
    document.querySelectorAll(".stats-preset-radio").forEach((radio) => {
      radio.addEventListener("change", function () {
        if (this.value === "custom") {
          if (customDates) customDates.classList.remove("hidden");
        } else {
          if (customDates) customDates.classList.add("hidden");
          statsForm.submit();
        }
      });
    });

    if (customRadio?.checked && customDates) {
      customDates.classList.remove("hidden");
    } else if (customDates) {
      customDates.classList.add("hidden");
    }
  }

  const chartSvg = document.querySelector(".trend-chart");
  const trendToggles = Array.from(document.querySelectorAll(".trend-legend-toggle"));
  const enabledTrendSeries = () => new Set(
    trendToggles.filter((toggle) => toggle.checked && !toggle.disabled).map((toggle) => toggle.dataset.series)
  );
  const compactTrendNumber = (value) => {
    const number = Number(value) || 0;
    if (number >= 1_000_000_000) return (number / 1_000_000_000).toFixed(2) + "B";
    if (number >= 1_000_000) return (number / 1_000_000).toFixed(2) + "M";
    if (number >= 1_000) return (number / 1_000).toFixed(1) + "K";
    return number.toLocaleString();
  };

  function reflowTrendChart() {
    if (!chartSvg) return;
    const enabled = enabledTrendSeries();
    const plotTop = Number(chartSvg.dataset.plotTop) || 0;
    const plotHeight = Number(chartSvg.dataset.plotHeight) || 1;
    const hits = Array.from(chartSvg.querySelectorAll(".trend-day-hit"));
    const barsByDay = hits.map(() => []);
    chartSvg.querySelectorAll(".trend-bar").forEach((bar) => {
      const dayIndex = Number(bar.dataset.dayIndex);
      if (barsByDay[dayIndex]) barsByDay[dayIndex].push(bar);
    });
    const visibleTotals = barsByDay.map((bars) => bars.reduce((sum, bar) =>
      enabled.has(bar.dataset.series) ? sum + (Number(bar.dataset.value) || 0) : sum, 0));
    const positiveTotals = visibleTotals.filter(Boolean).sort((a, b) => b - a);
    const maxTotal = Math.max(...visibleTotals, 1);
    const secondTotal = positiveTotals[1] || 0;
    const clippedScale = secondTotal > 0 && maxTotal > secondTotal * 4;
    const chartMax = clippedScale ? Math.max(1, secondTotal * 1.25) : maxTotal;
    const yValue = (value) => plotTop + plotHeight - (Math.min(value, chartMax) / chartMax) * plotHeight;

    chartSvg.querySelectorAll(".trend-y-label").forEach((label) => {
      const index = Number(label.dataset.gridIndex) || 0;
      label.textContent = compactTrendNumber(chartMax - (index / 4) * chartMax);
    });

    barsByDay.forEach((bars, dayIndex) => {
      let cumulative = 0;
      bars.forEach((bar) => {
        const visible = enabled.has(bar.dataset.series);
        bar.classList.toggle("hidden", !visible);
        if (!visible) return;
        const value = Number(bar.dataset.value) || 0;
        const baseY = yValue(cumulative);
        cumulative += value;
        const topY = yValue(cumulative);
        bar.setAttribute("y", String(topY));
        bar.setAttribute("height", String(Math.max(0, baseY - topY)));
      });

      const isClipped = clippedScale && visibleTotals[dayIndex] > chartMax;
      const marker = chartSvg.querySelector(`.trend-clipped-marker[data-day-index="${dayIndex}"]`);
      const label = chartSvg.querySelector(`.trend-clipped-label[data-day-index="${dayIndex}"]`);
      marker?.classList.toggle("hidden", !isClipped);
      label?.classList.toggle("hidden", !isClipped);
      if (label) label.textContent = compactTrendNumber(visibleTotals[dayIndex]);
      if (hits[dayIndex]) hits[dayIndex].dataset.visibleTotal = String(visibleTotals[dayIndex]);
    });
    document.querySelector(".trend-scale-note")?.classList.toggle("hidden", !clippedScale);
  }

  trendToggles.forEach((toggle) => {
    toggle.addEventListener("change", function () {
      reflowTrendChart();
    });
  });
  reflowTrendChart();

  const tooltip = document.getElementById("trend-tooltip");
  const chartBody = chartSvg?.closest(".stats-chart-body");
  if (chartBody) chartBody.style.position = "relative";
  if (tooltip && chartSvg && chartBody) {
      const seriesLabels = {
        total: ft("stats.legend_total"),
        output: ft("stats.legend_output"),
        input: ft("stats.legend_input"),
        reasoning: ft("stats.legend_reasoning"),
        cacheRead: ft("stats.legend_cache_read"),
        cacheWrite: ft("stats.legend_cache_write"),
        other: ft("stats.legend_other"),
      };
      const showTrendTooltip = function (hit, clientX, clientY) {
        if (!hit) {
          tooltip.hidden = true;
          return;
        }
        const day = hit.dataset.day;
        const visibleSeries = enabledTrendSeries();
        const total = Number(hit.dataset.visibleTotal) || 0;
        const values = [
          ["input", hit.dataset.input],
          ["cacheRead", hit.dataset.cacheRead],
          ["cacheWrite", hit.dataset.cacheWrite],
          ["output", hit.dataset.output],
          ["reasoning", hit.dataset.reasoning],
          ["other", hit.dataset.other],
        ].map(([series, raw]) => [series, Number(raw) || 0])
          .filter(([series, value]) => visibleSeries.has(series) && value > 0);
        tooltip.innerHTML = "<strong>" + day + "</strong>" +
          values.map(([series, value]) => "<span><i style=\"background:" + ({ input: "#60a5fa", cacheRead: "#34d399", cacheWrite: "#14b8a6", output: "#a78bfa", reasoning: "#fbbf24", other: "#64748b" }[series] || "#64748b") + "\"></i>" +
            formatText(ft("stats.tooltip_series"), { series: seriesLabels[series] || series, val: value.toLocaleString() }) + "</span>").join("") +
          "<b>" + formatText(ft("stats.tooltip_total"), { total: total.toLocaleString() }) + "</b>";
        tooltip.hidden = false;

        const chartBodyRect = chartBody.getBoundingClientRect();
        const hitRect = hit.getBoundingClientRect();
        const anchorX = Number.isFinite(clientX) ? clientX : hitRect.left + hitRect.width / 2;
        const anchorY = Number.isFinite(clientY) ? clientY : hitRect.top + hitRect.height / 2;
        const rawLeft = anchorX - chartBodyRect.left + chartBody.scrollLeft + 12;
        const rawTop = anchorY - chartBodyRect.top + chartBody.scrollTop - tooltip.offsetHeight - 12;
        const minLeft = chartBody.scrollLeft;
        const maxLeft = Math.max(minLeft, chartBody.scrollLeft + chartBody.clientWidth - tooltip.offsetWidth);
        const minTop = chartBody.scrollTop;
        const maxTop = Math.max(minTop, chartBody.scrollTop + chartBody.clientHeight - tooltip.offsetHeight);
        tooltip.style.left = Math.min(maxLeft, Math.max(minLeft, rawLeft)) + "px";
        tooltip.style.top = Math.min(maxTop, Math.max(minTop, rawTop)) + "px";
      };

      chartSvg.addEventListener("mousemove", function (e) {
        showTrendTooltip(e.target.closest(".trend-hit"), e.clientX, e.clientY);
      });
      chartSvg.addEventListener("click", function (e) {
        const hit = e.target.closest(".trend-hit");
        const href = hit?.getAttribute("href");
        if (href) {
          e.preventDefault();
          window.location.assign(href);
        }
      });
      chartSvg.addEventListener("focusin", function (e) {
        showTrendTooltip(e.target.closest(".trend-hit"));
      });
      chartSvg.addEventListener("focusout", function (e) {
        if (!e.relatedTarget || !chartSvg.contains(e.relatedTarget)) tooltip.hidden = true;
      });
      chartSvg.addEventListener("mouseleave", function () {
        tooltip.hidden = true;
      });
  }

  document.querySelectorAll(".stats-filter-scope-label input[type='radio']").forEach((radio) => {
    radio.addEventListener("change", function () {
      document.querySelectorAll(".stats-filter-scope-label").forEach(l => l.classList.remove("active"));
      if (this.checked && this.closest(".stats-filter-scope-label")) {
        this.closest(".stats-filter-scope-label").classList.add("active");
      }
    });
  });

  // ── Token Explorer: Saved Views ──────────────────────────────────────────
  function initSavedViews() {
    const container = document.querySelector(".stats-saved-views");
    if (!container) return;
    const provider = container.dataset.provider;
    const storageKey = `agentsession-saved-views-${provider}`;
    const listEl = document.getElementById("saved-views-list");
    const template = document.getElementById("saved-view-template");
    const maxViews = 20;
    const expectedPath = `/${encodeURIComponent(provider)}/stats`;

    function normalizeViews(raw) {
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((view) => {
        if (!view || typeof view !== "object") return [];
        const name = typeof view.name === "string" ? view.name.trim().slice(0, 80) : "";
        const url = typeof view.url === "string" ? view.url : "";
        if (!name || !url) return [];
        try {
          const parsed = new URL(url, window.location.origin);
          if (parsed.origin !== window.location.origin || parsed.pathname !== expectedPath) return [];
          return [{ name, url: parsed.pathname + parsed.search }];
        } catch {
          return [];
        }
      }).slice(0, maxViews);
    }

    function loadViews() {
      try {
        return normalizeViews(JSON.parse(localStorage.getItem(storageKey) || "[]"));
      } catch { return []; }
    }

    function saveViews(views) {
      localStorage.setItem(storageKey, JSON.stringify(views));
    }

    function render() {
      if (!listEl) return;
      const views = loadViews();
      listEl.innerHTML = "";
      views.forEach((v, i) => {
        const clone = template.content.cloneNode(true);
        const link = clone.querySelector(".saved-view-link");
        const delBtn = clone.querySelector(".saved-view-delete");
        link.href = v.url;
        link.textContent = v.name;
        delBtn.addEventListener("click", () => {
          const current = loadViews();
          current.splice(i, 1);
          saveViews(current);
          render();
        });
        listEl.appendChild(clone);
      });
    }

    const saveBtn = document.getElementById("save-view-btn");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const views = loadViews();
        if (views.length >= maxViews) {
          showToast(ft("saved_views_max"));
          return;
        }
        const dialog = document.createElement("dialog");
        dialog.className = "saved-view-dialog";
        dialog.setAttribute("aria-labelledby", "saved-view-dialog-title");
        const label = ft("saved_views_name_prompt");
        dialog.innerHTML = `<form method="dialog">
          <label id="saved-view-dialog-title" for="saved-view-name">${escapeHtmlClient(label)}</label>
          <input id="saved-view-name" type="text" class="saved-view-input" maxlength="80" autocomplete="off">
          <div class="saved-view-dialog-actions">
            <button type="button" class="saved-view-dialog-save">${escapeHtmlClient(ft("saved_views_save"))}</button>
            <button type="button" class="saved-view-dialog-cancel">${escapeHtmlClient(ft("saved_views_cancel"))}</button>
          </div>
        </form>`;
        document.body.appendChild(dialog);
        const input = dialog.querySelector(".saved-view-input");
        const closeDialog = () => {
          if (dialog.open) dialog.close();
          dialog.remove();
        };
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.querySelector(".saved-view-dialog-cancel").addEventListener("click", closeDialog);
        dialog.querySelector(".saved-view-dialog-save").addEventListener("click", () => {
          const name = input.value.trim();
          closeDialog();
          if (!name) return;
          const url = window.location.pathname + window.location.search;
          views.push({ name, url });
          saveViews(views);
          render();
        });
        dialog.querySelector("form").addEventListener("submit", (event) => {
          event.preventDefault();
          dialog.querySelector(".saved-view-dialog-save").click();
        });
        dialog.showModal();
        input.focus();
      });
    }

    render();
  }

  // ── Token Explorer: Compare Selectors ────────────────────────────────────
  function initCompareSelectors() {
    const form = document.querySelector(".stats-filter-bar");
    if (!form) return;
    const selectA = form.querySelector("select[name='comparea']");
    const selectB = form.querySelector("select[name='compareb']");
    if (!selectA || !selectB) return;

    function update() {
      const valA = selectA.value;
      const valB = selectB.value;
      Array.from(selectA.options).forEach(opt => {
        opt.disabled = opt.value !== "" && opt.value === valB && valB !== "";
      });
      Array.from(selectB.options).forEach(opt => {
        opt.disabled = opt.value !== "" && opt.value === valA && valA !== "";
      });
    }

    selectA.addEventListener("change", update);
    selectB.addEventListener("change", update);
    update();
  }

  // ── Token Explorer: Deferred Sections ─────────────────────────────────────
  function initDeferredStats() {
    const sections = Array.from(document.querySelectorAll("[data-stats-deferred-url]"));
    if (!sections.length) return;

    const load = async (section) => {
      if (section.dataset.statsDeferredState === "loading" || section.dataset.statsDeferredState === "loaded") return;
      section.dataset.statsDeferredState = "loading";
      try {
        const url = new URL(section.dataset.statsDeferredUrl, window.location.origin);
        url.searchParams.set("section", section.dataset.statsDeferredSection);
        const response = await fetch(url, { headers: { Accept: "text/html" } });
        if (!response.ok) throw new Error(`Deferred stats request failed: ${response.status}`);
        section.innerHTML = await response.text();
        section.dataset.statsDeferredState = "loaded";
        section.removeAttribute("aria-busy");
      } catch (error) {
        console.error(error);
        section.innerHTML = `<p class="stats-empty">${escapeHtmlClient(ft("stats.load_failed"))}</p>`;
        section.dataset.statsDeferredState = "failed";
        section.removeAttribute("aria-busy");
      }
    };

    const secondary = sections.filter((section) => section.dataset.statsDeferredSection === "secondary");
    if (secondary.length) {
      if ("IntersectionObserver" in window) {
        const observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            void load(entry.target);
          }
        }, { rootMargin: "320px 0px" });
        secondary.forEach((section) => observer.observe(section));
      } else {
        secondary.forEach((section) => { void load(section); });
      }
    }

    sections
      .filter((section) => section.dataset.statsDeferredSection === "advanced")
      .forEach((section) => {
        const details = section.closest("details");
        if (!details) return;
        if (details.open) void load(section);
        details.addEventListener("toggle", () => {
          if (details.open) void load(section);
        });
      });
  }

  initSavedViews();

  initCompareSelectors();

  initDeferredStats();
})();

}
