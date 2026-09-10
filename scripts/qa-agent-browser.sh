#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AGENTSESSION_QA_PORT:-3470}"
DB_PATH="${AGENTSESSION_QA_DB_PATH:-${AGENTSESSION_DB_PATH:-$HOME/.local/share/opencode/opencode.db}}"
SAMPLE_SESSION_ID="${AGENTSESSION_QA_SESSION_ID:-}"
SESSION_NAME="${AGENTSESSION_QA_BROWSER_SESSION:-agentsession-qa-$PORT-$$}"
BASE="${AGENTSESSION_QA_BASE_URL:-http://127.0.0.1:$PORT}"
TERMINAL_LAUNCH="${AGENTSESSION_QA_TERMINAL_LAUNCH:-enabled}"

if [[ -z "$SAMPLE_SESSION_ID" ]]; then
  echo "AGENTSESSION_QA_SESSION_ID is required. Set it to a real OpenCode session with reasoning, tools, tokens, and subagent activity." >&2
  exit 2
fi

mkdir -p "$ROOT/tmp" "$ROOT/logs"
export npm_config_cache="$ROOT/tmp/npm-cache"
browser() {
  if [[ -n "${AGENTSESSION_QA_NPX:-}" ]]; then
    "${AGENTSESSION_QA_NPX}" --yes agent-browser "$@"
  elif command -v agent-browser >/dev/null 2>&1; then
    agent-browser "$@"
  else
    npx --yes agent-browser "$@"
  fi
}

cleanup() {
  browser --session "$SESSION_NAME" close --all >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_server() {
  local url="$BASE/api/opencode/stats"
  for _ in $(seq 1 40); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Server did not become ready at $url" >&2
  return 1
}

ab() {
  local label="$1"
  shift
  echo "[qa] agent-browser: $label" >&2
  browser --session "$SESSION_NAME" "$@"
}

read_ab() {
  local label="$1"
  shift
  local slug
  slug="$(printf '%s' "$label" | tr -cs 'A-Za-z0-9_-' '-' | tr 'A-Z' 'a-z')"
  local out="$ROOT/tmp/qa-agent-browser-$slug.out.txt"
  echo "[qa] agent-browser: $label" >&2
  browser --session "$SESSION_NAME" "$@" > "$out"
  cat "$out"
}

assert_contains() {
  local label="$1"
  local text="$2"
  local pattern="$3"
  if [[ "$text" != *"$pattern"* ]]; then
    echo "$label did not include $pattern" >&2
    return 1
  fi
}

assert_not_contains() {
  local label="$1"
  local text="$2"
  local pattern="$3"
  if [[ "$text" == *"$pattern"* ]]; then
    echo "$label unexpectedly included $pattern" >&2
    return 1
  fi
}

assert_positive_count() {
  local label="$1"
  local count="$2"
  if ! [[ "$count" =~ ^[0-9]+$ ]] || (( count <= 0 )); then
    echo "$label expected a positive count, got $count" >&2
    return 1
  fi
}

wait_for_server

ab "clear previous session" close --all >/dev/null || true

ab "open centralized sessions" open "$BASE/sessions" >/dev/null
ab "wait for centralized sessions" wait --text "Library" >/dev/null
global_session_state="$(read_ab "verify centralized session providers" eval "JSON.stringify({ filters: document.querySelectorAll('.provider-filter input[name=provider]:checked').length, badges: document.querySelectorAll('.session-provider-badge').length, badLinks: [...document.querySelectorAll('.session-card-title-link')].filter((link) => !/^\\/[a-z][a-z0-9-]*\\/session\\//.test(link.getAttribute('href') || '')).length })")"
if ! printf '%s' "$global_session_state" | grep -Eq 'filters[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_session_state" | grep -Eq 'badLinks[^0-9]*0'; then
  echo "Centralized sessions should expose selected provider filters and canonical provider-owned detail links, got $global_session_state" >&2
  exit 1
fi

global_project_state="$(read_ab "verify equivalent project paths are merged" eval "(() => { const normalize = (value) => { let path = String(value || '').trim().replaceAll('\\\\', '/'); const wsl = path.match(/^\\/mnt\\/([a-z])(?:\\/(.*))?$/i); if (wsl) path = wsl[1] + ':/' + (wsl[2] || ''); if (/^[a-z]:\\/+$/i.test(path)) return path[0].toLowerCase() + ':/'; path = path.replace(/\\/+$/, ''); return /^[a-z]:\\//i.test(path) ? path.toLowerCase() : path; }; const values = [...document.querySelectorAll('select[name=project] option')].map((option) => normalize(option.value)).filter(Boolean); return values.length === new Set(values).size; })()")"
if [[ "$global_project_state" != "true" ]]; then
  echo "Centralized Sessions should merge equivalent Windows and WSL project paths, got $global_project_state" >&2
  exit 1
fi

ab "open centralized usage" open "$BASE/stats" >/dev/null
ab "wait for centralized usage" wait --text "Usage by provider" >/dev/null
global_usage_state="$(read_ab "verify centralized usage" eval "(() => { const before = [...document.querySelectorAll('.trend-y-label')].map((x) => x.textContent.trim()); [...document.querySelectorAll('.trend-legend-toggle')].filter((x) => x.dataset.series !== 'output' && x.checked).forEach((x) => x.click()); const after = [...document.querySelectorAll('.trend-y-label')].map((x) => x.textContent.trim()); const cards = [...document.querySelectorAll('.stats-provider-breakdown-card')]; return JSON.stringify({ providers: document.querySelectorAll('.stats-provider-selector input[name=provider]:checked').length, breakdown: cards.length, unifiedLinks: cards.filter((card) => /^\/stats\?provider=/.test(card.querySelector('.stats-provider-filter-link')?.getAttribute('href') || '')).length, detailLinks: cards.filter((card) => /^\/[a-z][a-z0-9-]*\/stats/.test(card.querySelector('.stats-provider-details')?.getAttribute('href') || '')).length, totalsMatch: document.querySelector('[data-provider-token-total]')?.dataset.providerTokenTotal === document.querySelector('[data-token-total]')?.dataset.tokenTotal, explicitActions: cards.filter((card) => /Show only /.test(card.textContent || '')).length, rescaled: before[0] !== after[0] }); })()")"
if ! printf '%s' "$global_usage_state" | grep -Eq 'providers[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_usage_state" | grep -Eq 'breakdown[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_usage_state" | grep -Eq 'unifiedLinks[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_usage_state" | grep -Eq 'detailLinks[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_usage_state" | grep -Eq 'totalsMatch[^a-z]*true' || ! printf '%s' "$global_usage_state" | grep -Eq 'explicitActions[^0-9]*[1-9][0-9]*' || ! printf '%s' "$global_usage_state" | grep -Eq 'rescaled[^a-z]*true'; then
  echo "Centralized Usage should expose provider filters, provider breakdown, and dynamic chart rescaling, got $global_usage_state" >&2
  exit 1
fi

trend_tooltip_bounds="$(read_ab "verify trend tooltip stays within its scroll viewport" eval "(() => { const body = document.querySelector('.stats-chart-body'); const hits = [...document.querySelectorAll('.trend-day-hit')]; if (!body || hits.length === 0) return 'missing'; const tooltip = document.getElementById('trend-tooltip'); const bodyRect = body.getBoundingClientRect(); const probe = (hit, clientX, clientY) => { hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY })); const tooltipRect = tooltip?.getBoundingClientRect(); return tooltipRect && tooltipRect.left >= bodyRect.left - 1 && tooltipRect.right <= bodyRect.right + 1 && tooltipRect.top >= bodyRect.top - 1 && tooltipRect.bottom <= bodyRect.bottom + 1; }; const firstRect = hits[0].getBoundingClientRect(); const lastRect = hits.at(-1).getBoundingClientRect(); const withinBounds = probe(hits[0], firstRect.left + 1, firstRect.top + 1) && probe(hits.at(-1), lastRect.right - 1, lastRect.bottom - 1); return JSON.stringify({ visible: !tooltip?.hidden, noOverflow: body.scrollWidth <= body.clientWidth + 1, withinBounds }); })()")"
if ! printf '%s' "$trend_tooltip_bounds" | grep -Eq 'visible[^a-z]*true' || ! printf '%s' "$trend_tooltip_bounds" | grep -Eq 'noOverflow[^a-z]*true' || ! printf '%s' "$trend_tooltip_bounds" | grep -Eq 'withinBounds[^a-z]*true'; then
  echo "Trend tooltip should not create horizontal overflow or leave its chart viewport, got $trend_tooltip_bounds" >&2
  exit 1
fi

usage_drilldown_started="$(read_ab "drill into one usage provider" eval "(() => { const link = document.querySelector('.stats-provider-filter-link'); if (!link) return false; link.click(); return true; })()")"
if [[ "$usage_drilldown_started" != "true" ]]; then
  echo "Centralized Usage should provide a provider drill-down card" >&2
  exit 1
fi
ab "wait for focused usage" wait --text "Show all providers" >/dev/null
focused_usage_state="$(read_ab "verify focused usage reset" eval "(() => { const cards = [...document.querySelectorAll('.stats-provider-breakdown-card')]; const selected = cards.filter((card) => card.classList.contains('is-selected')); return JSON.stringify({ providers: document.querySelectorAll('.stats-provider-selector input[name=provider]:checked').length, selected: selected.length, resetLinks: selected.filter((card) => { const link = card.querySelector('.stats-provider-filter-link'); return /^\/stats\?days=/.test(link?.getAttribute('href') || '') && /Show all providers/.test(link?.textContent || ''); }).length }); })()")"
if ! printf '%s' "$focused_usage_state" | grep -Eq 'providers[^0-9]*1' || ! printf '%s' "$focused_usage_state" | grep -Eq 'selected[^0-9]*1' || ! printf '%s' "$focused_usage_state" | grep -Eq 'resetLinks[^0-9]*1'; then
  echo "Focused Usage should offer a one-click return to all providers, got $focused_usage_state" >&2
  exit 1
fi
read_ab "restore all usage providers" eval "document.querySelector('.stats-provider-breakdown-card.is-selected .stats-provider-filter-link').click(); true" >/dev/null
ab "wait for unified usage reset" wait --text "Show only" >/dev/null

ab "open dashboard" open "$BASE/opencode" >/dev/null
ab "wait for dashboard" wait --text "Library" >/dev/null
dashboard="$(read_ab "read dashboard" get text body)"
assert_contains "dashboard" "$dashboard" "Library"
dashboard_session_ids="$(read_ab "count dashboard session ids" get count ".session-card[data-session-id]")"
assert_positive_count "dashboard session ids" "$dashboard_session_ids"
dashboard_copy_buttons="$(read_ab "count dashboard copy buttons" get count ".session-card [data-action='copy-session-id']")"
assert_positive_count "dashboard session ID copy buttons" "$dashboard_copy_buttons"
global_search_placeholder="$(read_ab "read global search placeholder" get attr "#search-input" placeholder)"
if [[ "$global_search_placeholder" != "Search titles and projects... ( / )" ]]; then
  echo "Global navigation search should honestly describe its metadata scope, got $global_search_placeholder" >&2
  exit 1
fi
list_filter_label="$(read_ab "read list filter label" get text ".filter-keyword > span")"
if [[ "${list_filter_label,,}" != "filter current list" ]]; then
  echo "List filter should identify its scoped behavior, got $list_filter_label" >&2
  exit 1
fi
summary_present="$(read_ab "verify library summary strip" get count ".library-summary")"
assert_positive_count "library summary strip" "$summary_present"
chip_count="$(read_ab "count quick filter chips" get count ".filter-chip")"
if [[ "$chip_count" -lt 4 ]]; then
  echo "Library should expose today/week/starred/has-subagent chips, got $chip_count" >&2
  exit 1
fi
view_toggle_count="$(read_ab "count view toggle buttons" get count ".library-view-toggle [data-view]")"
if [[ "$view_toggle_count" -ne 2 ]]; then
  echo "Library view toggle should expose timeline and compact modes, got $view_toggle_count" >&2
  exit 1
fi
advanced_filters_present="$(read_ab "verify advanced filters disclosure" get count "#advanced-filters")"
assert_positive_count "advanced filters disclosure" "$advanced_filters_present"
summary_chip_roundtrip="$(read_ab "verify chip links preserve the current list context" eval "(() => { const chips = [...document.querySelectorAll('.filter-chip')]; const samePath = chips.every((chip) => (chip.getAttribute('href') || '').split('?')[0] === location.pathname); const params = new URLSearchParams((chips[0]?.getAttribute('href') || '').split('?')[1] || ''); return (samePath ? 'same-path' : 'wrong-path') + '|' + params.getAll('provider').join(','); })()")"
if [[ "$summary_chip_roundtrip" != *"same-path|"* ]]; then
  echo "Filter chips should round-trip to the same list path, got $summary_chip_roundtrip" >&2
  exit 1
fi
if [[ "$summary_chip_roundtrip" != *"same-path|\""* ]]; then
  echo "Provider-page chips should not invent cross-provider params, got $summary_chip_roundtrip" >&2
  exit 1
fi
rail_state="$(read_ab "verify primary rail links" eval "JSON.stringify([...document.querySelectorAll('.rail-link')].map((link) => ({ text: link.textContent.trim(), href: link.getAttribute('href'), shortcut: link.dataset.navShortcut, current: link.getAttribute('aria-current') })))")"
assert_contains "primary rail" "$rail_state" "Library"
assert_contains "primary rail" "$rail_state" "Statistics"
assert_contains "primary rail" "$rail_state" "Settings"
assert_contains "primary rail" "$rail_state" "\\\"shortcut\\\":\\\"1\\\""
assert_contains "primary rail" "$rail_state" "\\\"shortcut\\\":\\\"2\\\""
assert_contains "primary rail" "$rail_state" "\\\"shortcut\\\":\\\"3\\\""
MSYS2_ARG_CONV_EXCL='*' browser --session "$SESSION_NAME" press 2 >/dev/null
keyboard_stats_path="$(read_ab "verify keyboard Statistics shortcut" eval "location.pathname")"
if [[ "$keyboard_stats_path" != "/stats" && "$keyboard_stats_path" != "\"/stats\"" ]]; then
  echo "Keyboard 2 should navigate to Statistics, got $keyboard_stats_path" >&2
  exit 1
fi
ab "return to Library after keyboard shortcut" open "$BASE/opencode" >/dev/null
editable_shortcut_path="$(read_ab "verify editable shortcut protection" eval "(() => { const input = document.querySelector('#search-input'); input?.focus(); return document.activeElement === input; })()")"
if [[ "$editable_shortcut_path" != "true" ]]; then
  echo "Dashboard search input should be focusable for editable-target protection" >&2
  exit 1
fi
MSYS2_ARG_CONV_EXCL='*' browser --session "$SESSION_NAME" press 1 >/dev/null
editable_shortcut_path="$(read_ab "read editable shortcut destination" eval "location.pathname")"
if [[ "$editable_shortcut_path" != "/opencode" && "$editable_shortcut_path" != "\"/opencode\"" ]]; then
  echo "Keyboard 1 should not navigate while the dashboard search is focused, got $editable_shortcut_path" >&2
  exit 1
fi
rename_dialog_count="$(read_ab "open rename dialog" eval "(() => { const card = document.querySelector('.session-card'); const trigger = card?.querySelector('.card-menu-trigger'); trigger?.click(); card?.querySelector('[data-action=\"rename\"]')?.click(); return document.querySelectorAll('.rename-dialog[role=\"dialog\"][aria-modal=\"true\"]').length; })()")"
if [[ "$rename_dialog_count" != "1" ]]; then
  echo "Rename should open one in-page dialog, got $rename_dialog_count" >&2
  exit 1
fi
rename_tab_result="$(read_ab "verify rename dialog focus wrap" eval "(() => { const save = document.querySelector('.rename-dialog button[type=\"submit\"]'); const input = document.querySelector('.rename-dialog input'); save?.focus(); save?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return document.activeElement === input ? 'wrapped' : (document.activeElement?.textContent || document.activeElement?.tagName || ''); })()")"
if [[ "$rename_tab_result" != "wrapped" && "$rename_tab_result" != '"wrapped"' ]]; then
  echo "Rename dialog should wrap focus from Save back to the input, got $rename_tab_result" >&2
  exit 1
fi
ab "dismiss rename dialog" press Escape >/dev/null
rename_dialog_closed="$(read_ab "count dismissed rename dialog" get count ".rename-dialog")"
if [[ "$rename_dialog_closed" != "0" ]]; then
  echo "Rename dialog should close on Escape, got $rename_dialog_closed" >&2
  exit 1
fi
rename_focus_restored="$(read_ab "check rename focus restore" eval "document.activeElement?.classList.contains('card-menu-trigger') ? 'trigger' : (document.activeElement?.tagName || '')")"
if [[ "$rename_focus_restored" != "trigger" && "$rename_focus_restored" != '"trigger"' ]]; then
  echo "Rename dialog should restore focus to the visible menu trigger, got $rename_focus_restored" >&2
  exit 1
fi
delete_confirm_count="$(read_ab "open delete confirmation" eval "(() => { const card = document.querySelector('.session-card'); const trigger = card?.querySelector('.card-menu-trigger'); trigger?.click(); card?.querySelector('[data-action=\"delete\"]')?.click(); return document.querySelectorAll('.confirm-dialog[role=\"dialog\"][aria-modal=\"true\"][aria-describedby=\"confirm-dialog-message\"] #confirm-dialog-message').length; })()")"
if [[ "$delete_confirm_count" != "1" ]]; then
  echo "Delete should open one in-page confirmation dialog, got $delete_confirm_count" >&2
  exit 1
fi
delete_tab_result="$(read_ab "verify delete confirmation focus wrap" eval "(() => { const confirm = document.querySelector('.confirm-dialog button[type=\"submit\"]'); const cancel = document.querySelector('.confirm-dialog button[type=\"button\"]'); confirm?.focus(); confirm?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return document.activeElement === cancel ? 'wrapped' : (document.activeElement?.textContent || document.activeElement?.tagName || ''); })()")"
if [[ "$delete_tab_result" != "wrapped" && "$delete_tab_result" != '"wrapped"' ]]; then
  echo "Delete confirmation should wrap focus from Delete back to Cancel, got $delete_tab_result" >&2
  exit 1
fi
ab "dismiss delete confirmation" press Escape >/dev/null
delete_confirm_closed="$(read_ab "count dismissed delete confirmation" get count ".confirm-dialog")"
if [[ "$delete_confirm_closed" != "0" ]]; then
  echo "Delete confirmation should close on Escape, got $delete_confirm_closed" >&2
  exit 1
fi
delete_focus_restored="$(read_ab "check delete focus restore" eval "document.activeElement?.classList.contains('card-menu-trigger') ? 'trigger' : (document.activeElement?.tagName || '')")"
if [[ "$delete_focus_restored" != "trigger" && "$delete_focus_restored" != '"trigger"' ]]; then
  echo "Delete confirmation should restore focus to the visible menu trigger, got $delete_focus_restored" >&2
  exit 1
fi
post_delete_dashboard_count="$(read_ab "count dashboard sessions after dismissed delete" get count ".session-card[data-session-id]")"
assert_positive_count "dashboard sessions after dismissed delete" "$post_delete_dashboard_count"

ab "open stats" open "$BASE/opencode/stats" >/dev/null
ab "wait for stats" wait --text "Statistics" >/dev/null
stats_section_order="$(read_ab "verify Statistics section order" eval "JSON.stringify([...document.querySelectorAll('[data-stats-section]')].map((section) => section.dataset.statsSection))")"
if [[ "$stats_section_order" != '["filters","summary","primary-trend","supporting"]' && "$stats_section_order" != '"[\"filters\",\"summary\",\"primary-trend\",\"supporting\"]"' ]]; then
  echo "Statistics should read header, filters, summary, trend, and supporting sections in order, got $stats_section_order" >&2
  exit 1
fi
stats_chart_explanation="$(read_ab "verify Statistics chart unit and summary" eval "Boolean(document.querySelector('.stats-chart-unit')?.textContent.trim()) && Boolean(document.querySelector('.stats-chart-summary')?.textContent.trim())")"
if [[ "$stats_chart_explanation" != "true" && "$stats_chart_explanation" != '"true"' ]]; then
  echo "Statistics trend should expose a unit and text summary, got $stats_chart_explanation" >&2
  exit 1
fi
page_token_total="$(read_ab "read stats token total" get attr ".stats-summary-value[data-token-total]" data-token-total)"
api_token_total="$(curl -fsS "$BASE/api/opencode/stats" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).totalTokens)))")"
if [[ "$page_token_total" != "$api_token_total" ]]; then
  echo "Stats page token total $page_token_total did not match API total $api_token_total" >&2
  exit 1
fi
stats_export_count="$(read_ab "count canonical stats exports" eval "[...document.querySelectorAll('.stats-export-link')].filter((link) => /^\/api\/opencode\/stats\/export\.(json|csv)\?/.test(link.getAttribute('href') || '')).length")"
if [[ "$stats_export_count" != "2" ]]; then
  echo "Token Explorer should expose two canonical export links, got $stats_export_count" >&2
  exit 1
fi
stats_advanced_count="$(read_ab "count progressive advanced stats sections" get count ".stats-advanced-details")"
if [[ "$stats_advanced_count" != "1" ]]; then
  echo "SQLite Token Explorer should expose one progressive advanced section, got $stats_advanced_count" >&2
  exit 1
fi
saved_view_result="$(read_ab "save and delete a stats view" eval "(() => { const key = 'agentsession-saved-views-opencode'; localStorage.removeItem(key); document.getElementById('save-view-btn')?.click(); const dialog = document.querySelector('.saved-view-dialog'); const input = dialog?.querySelector('.saved-view-input'); if (!dialog?.open || !input) return 'dialog-missing'; input.value = 'QA 7 days'; dialog.querySelector('.saved-view-dialog-save')?.click(); const saved = JSON.parse(localStorage.getItem(key) || '[]'); const link = document.querySelector('.saved-view-link'); const ok = saved.length === 1 && saved[0].name === 'QA 7 days' && link?.getAttribute('href')?.includes('/opencode/stats'); document.querySelector('.saved-view-delete')?.click(); return ok && JSON.parse(localStorage.getItem(key) || '[]').length === 0 ? 'ok' : 'failed'; })()")"
if [[ "$saved_view_result" != "ok" && "$saved_view_result" != '"ok"' ]]; then
  echo "Saved views should persist the current provider URL and remain deletable, got $saved_view_result" >&2
  exit 1
fi

ab "open file-provider stats" open "$BASE/codex/stats?days=7" >/dev/null
ab "wait for file-provider stats" wait --text "Statistics" >/dev/null
file_stats_capability_state="$(read_ab "verify file-provider stats capability gates" eval "document.querySelectorAll('[name=model], [name=scope], .stats-advanced-details, .stats-model-ranking, .stats-top-sessions, .stats-coverage').length === 0 && document.body.innerText.includes('aggregate token data only')")"
if [[ "$file_stats_capability_state" != "true" ]]; then
  echo "File-provider Token Explorer should stay aggregate-only without advanced SQLite controls" >&2
  exit 1
fi

ab "open settings" open "$BASE/opencode/settings" >/dev/null
ab "wait for settings" wait --text "Project directory mappings" >/dev/null
settings="$(read_ab "read settings" get text body)"
assert_contains "settings" "$settings" "CONFIGURATION FILE"
if [[ "$TERMINAL_LAUNCH" == "disabled" ]]; then
  assert_contains "settings" "$settings" "Disabled for this server process"
else
  assert_contains "settings" "$settings" "Enabled for this server process"
fi
settings_editor_count="$(read_ab "count settings editor" get count "#settings-json")"
if [[ "$settings_editor_count" != "1" ]]; then
  echo "Settings page should render one JSON editor, got $settings_editor_count" >&2
  exit 1
fi
settings_switch_count="$(read_ab "count settings switches" get count ".settings-switch input[type='checkbox']")"
if ! [[ "$settings_switch_count" =~ ^[0-9]+$ ]] || (( settings_switch_count < 1 )); then
  echo "Settings page should render at least one switch, got $settings_switch_count" >&2
  exit 1
fi
settings_single_column="$(read_ab "verify single-column settings groups" eval "(() => { const grid = document.querySelector('.settings-fields-grid'); return Boolean(grid) && getComputedStyle(grid).gridTemplateColumns.split(' ').length === 1 && document.querySelectorAll('#settings-project-paths small').length === 1; })()")"
if [[ "$settings_single_column" != "true" && "$settings_single_column" != '"true"' ]]; then
  echo "Settings should use one labeled column with one owning project-path help, got $settings_single_column" >&2
  exit 1
fi
ab "open advanced settings JSON" click "[data-open-settings-advanced]" >/dev/null
ab "enter invalid settings JSON" fill "#settings-json" "{" >/dev/null
invalid_settings_save_disabled="$(read_ab "read invalid settings save disabled" eval "document.querySelector('.settings-save')?.disabled")"
if [[ "$invalid_settings_save_disabled" != "true" ]]; then
  echo "Settings save should be disabled while advanced JSON is invalid, got $invalid_settings_save_disabled" >&2
  exit 1
fi
invalid_settings_feedback="$(read_ab "read invalid settings JSON feedback" eval "document.getElementById('settings-json-feedback')?.innerText.includes('Enter valid JSON before saving')")"
if [[ "$invalid_settings_feedback" != "true" ]]; then
  echo "Settings invalid JSON feedback should explain the save blocker, got $invalid_settings_feedback" >&2
  exit 1
fi

ab "open search" open "$BASE/opencode/search?q=assistant" >/dev/null
ab "wait for search" wait --text "Search" >/dev/null

ab "open session detail" open "$BASE/opencode/session/$SAMPLE_SESSION_ID" >/dev/null
work_graph_default="$(read_ab "verify Work default tab" eval "document.getElementById('tab-btn-work')?.getAttribute('aria-selected') === 'true' && !document.getElementById('tab-work')?.hidden")"
if [[ "$work_graph_default" != "true" ]]; then
  echo "Session detail should open on Work, got $work_graph_default" >&2
  exit 1
fi
ab "open Find in conversation from Work" click "[data-session-search-toggle]" >/dev/null
sleep 0.25
find_from_work_state="$(read_ab "verify Find switches to Conversation" eval "JSON.stringify({ selected: document.querySelector('#tab-btn-conversation')?.getAttribute('aria-selected'), panelHidden: document.querySelector('#tab-conversation')?.hidden, searchOpen: document.querySelector('[data-session-search]')?.open, focused: document.activeElement === document.querySelector('[data-session-search-input]') })")"
assert_contains "Find from Work" "$find_from_work_state" "\\\"selected\\\":\\\"true\\\""
assert_contains "Find from Work" "$find_from_work_state" "\\\"searchOpen\\\":true"
assert_contains "Find from Work" "$find_from_work_state" "\\\"focused\\\":true"
ab "wait for reasoning" wait ".reasoning-block" >/dev/null
detail="$(read_ab "read session detail" get text body)"
assert_not_contains "detail" "$detail" "System Prompts"
assert_contains "detail" "$detail" "Find in conversation"
detail_header_state="$(read_ab "verify recorded detail header evidence" eval "(() => { const text = document.querySelector('.session-header')?.innerText || ''; return ['project=' + text.includes('PROJECT'), 'started=' + text.includes('STARTED'), 'files=' + text.includes('Files'), 'clean=' + !/undefined|null/.test(text)].join(';'); })()")"
assert_contains "detail header" "$detail_header_state" "project=true"
assert_contains "detail header" "$detail_header_state" "started=true"
assert_contains "detail header" "$detail_header_state" "files=true"
assert_contains "detail header" "$detail_header_state" "clean=true"
detail_session_workbench_id="$(read_ab "read detail session id" get attr ".session-workbench" data-session-id)"
if [[ "$detail_session_workbench_id" != "$SAMPLE_SESSION_ID" && "$detail_session_workbench_id" != "\"$SAMPLE_SESSION_ID\"" ]]; then
  echo "Detail session workbench ID did not include $SAMPLE_SESSION_ID" >&2
  exit 1
fi
detail_tool_count="$(read_ab "count detail tool calls" get count ".tool-call")"
assert_positive_count "detail tool calls" "$detail_tool_count"

detail_session_id_count="$(read_ab "count detail session id" get count ".session-header .session-id")"
if [[ "$detail_session_id_count" != "0" ]]; then
  echo "Detail page should keep the session ID out of the persistent header, got $detail_session_id_count" >&2
  exit 1
fi
detail_copy_id_count="$(read_ab "count detail session ID menu actions" get count ".session-actions [data-action='copy-session-id']")"
if [[ "$detail_copy_id_count" != "1" ]]; then
  echo "Detail page should keep one copy-session-ID action in More, got $detail_copy_id_count" >&2
  exit 1
fi

ab "open transcript search" click "[data-session-search-toggle]" >/dev/null
ab "search transcript" fill "[data-session-search-input]" "tool" >/dev/null
ab "wait for transcript search results" wait --fn "document.querySelector('[data-session-search-status]')?.textContent.includes('hits')" >/dev/null
transcript_search_feedback="$(read_ab "verify transcript search feedback" eval "(() => document.querySelectorAll('mark[data-session-search-highlight]').length > 0 && document.querySelectorAll('.session-search-current').length === 1 && /[0-9]+ \/ [0-9]+ turns · [0-9]+ hits/.test(document.querySelector('[data-session-search-status]')?.textContent || ''))()")"
if [[ "$transcript_search_feedback" != "true" ]]; then
  echo "Transcript search should show word highlights, one current turn, and explicit turn/hit counts" >&2
  exit 1
fi
read_ab "remember transcript search scroll" eval "window.__qaTranscriptSearchScrollY = window.scrollY; true" >/dev/null
ab "close transcript search" click "[data-session-search-close]" >/dev/null
transcript_search_close_state="$(read_ab "verify transcript search close position" eval "!document.querySelector('[data-session-search]').open && Math.abs(window.scrollY - window.__qaTranscriptSearchScrollY) < 2")"
if [[ "$transcript_search_close_state" != "true" ]]; then
  echo "Closing transcript search should preserve the current result scroll position" >&2
  exit 1
fi
echo "[qa] agent-browser: reopen transcript search with shortcut" >&2
MSYS2_ARG_CONV_EXCL='*' browser --session "$SESSION_NAME" press / >/dev/null
# A browser-side wait here can wedge the Windows agent-browser transport after
# a synthetic key press. Let the native details/focus events settle briefly,
# then keep the same strict state assertion below.
sleep 0.25
transcript_search_shortcut_state="$(read_ab "verify transcript search shortcut" eval "document.querySelector('[data-session-search]').open && document.activeElement === document.querySelector('[data-session-search-input]')")"
if [[ "$transcript_search_shortcut_state" != "true" ]]; then
  echo "The slash shortcut should open transcript search and focus its input" >&2
  exit 1
fi
ab "close transcript search after shortcut" press Escape >/dev/null

ab "open Work before slash shortcut" click "#tab-btn-work" >/dev/null
MSYS2_ARG_CONV_EXCL='*' browser --session "$SESSION_NAME" press / >/dev/null
sleep 0.25
slash_from_work_state="$(read_ab "verify slash switches to Conversation" eval "JSON.stringify({ selected: document.querySelector('#tab-btn-conversation')?.getAttribute('aria-selected'), searchOpen: document.querySelector('[data-session-search]')?.open, focused: document.activeElement === document.querySelector('[data-session-search-input]') })")"
assert_contains "slash from Work" "$slash_from_work_state" "\\\"selected\\\":\\\"true\\\""
assert_contains "slash from Work" "$slash_from_work_state" "\\\"searchOpen\\\":true"
assert_contains "slash from Work" "$slash_from_work_state" "\\\"focused\\\":true"
ab "close transcript search after Work slash" press Escape >/dev/null

resume_preview_count="$(read_ab "count resume command previews" get count ".resume-command-preview")"
resume_copy_count="$(read_ab "count resume command copy buttons" get count ".resume-command-preview [data-action='copy-resume-command']")"
resume_launch_count="$(read_ab "count terminal launch buttons" get count ".session-actions [data-action='resume-session']")"
if [[ "$TERMINAL_LAUNCH" == "disabled" ]]; then
  if [[ "$resume_launch_count" != "0" || "$resume_preview_count" != "0" || "$resume_copy_count" != "0" ]]; then
    echo "Terminal controls should be hidden with --disable-terminal-launch" >&2
    exit 1
  fi
else
  if [[ "$resume_launch_count" != "1" || "$resume_preview_count" != "1" || "$resume_copy_count" != "1" ]]; then
    echo "Terminal launch, preview, and copy buttons should be visible by default" >&2
    exit 1
  fi
fi

tab_layout_state="$(read_ab "verify stable session tab layout" eval "(() => { const workbench = document.querySelector('.session-workbench'); const main = workbench?.querySelector('.main-content'); const events = document.getElementById('tab-btn-events'); const conversation = document.getElementById('tab-btn-conversation'); if (!workbench || !main || !events || !conversation) return false; conversation.click(); const conversationGrid = getComputedStyle(workbench).gridTemplateColumns.trim().split(/\\s+/).length; events.click(); const eventGrid = getComputedStyle(workbench).gridTemplateColumns.trim().split(/\\s+/).length; const eventMainColumn = getComputedStyle(main).gridColumnStart; conversation.click(); return conversationGrid === 2 && eventGrid === 1 && eventMainColumn === '1' && workbench.classList.contains('session-conversation-tab-active'); })()")"
if [[ "$tab_layout_state" != "true" ]]; then
  echo "Session tab changes should preserve the content position and width, got $tab_layout_state" >&2
  exit 1
fi

deep_link_state="$(read_ab "verify Conversation deep link" eval "(() => { const target = document.querySelector('#tab-conversation [id^=msg_]'); if (!target) return JSON.stringify({ ready: false }); location.assign(location.pathname + '?qa_deep_link=conversation#' + target.id); return JSON.stringify({ ready: true, id: target.id }); })()")"
sleep 0.7
conversation_hash_state="$(read_ab "read Conversation deep link state" eval "JSON.stringify({ hash: location.hash, selected: document.querySelector('#tab-btn-conversation')?.getAttribute('aria-selected'), hidden: document.querySelector('#tab-conversation')?.hidden })")"
assert_contains "Conversation deep link" "$deep_link_state" "ready"
assert_contains "Conversation deep link" "$conversation_hash_state" "\\\"selected\\\":\\\"true\\\""
assert_contains "Conversation deep link" "$conversation_hash_state" "\\\"hidden\\\":false"
ab "open Events deep link" open "$BASE/opencode/session/$SAMPLE_SESSION_ID?qa_deep_link=events#tab-events" >/dev/null
sleep 0.7
events_hash_state="$(read_ab "read Events deep link state" eval "JSON.stringify({ hash: location.hash, secondaryActive: document.querySelector('#tab-btn-events')?.classList.contains('is-active'), primaryCount: document.querySelectorAll('.tab-bar [role=tab]').length, returnTabIndex: document.querySelector('#tab-btn-work')?.tabIndex, hidden: document.querySelector('#tab-events')?.hidden, direct: Boolean(document.querySelector('#tab-events [data-runtime-events-root]')), shell: Boolean(document.querySelector('#tab-events #detail-events-shell')), table: Boolean(document.querySelector('#tab-events [data-runtime-event]')) })")"
assert_contains "Events deep link" "$events_hash_state" "\\\"direct\\\":true"
assert_contains "Events deep link" "$events_hash_state" "\\\"shell\\\":false"
assert_contains "Events deep link" "$events_hash_state" "\\\"table\\\":true"
assert_contains "Events deep link" "$events_hash_state" "\\\"secondaryActive\\\":true"
assert_contains "Events primary mode count" "$events_hash_state" "\\\"primaryCount\\\":2"
assert_contains "Events keyboard return" "$events_hash_state" "\\\"returnTabIndex\\\":0"
assert_contains "Events deep link" "$events_hash_state" "\\\"hidden\\\":false"
ab "restore Conversation after deep links" click "#tab-btn-conversation" >/dev/null

toc_unexpected="$(read_ab "count unexpected toc entries" get count ".session-toc .toc-link:not(.toc-user):not(.toc-assistant):not(.toc-agent):not(.toc-task)")"
if [[ "$toc_unexpected" != "0" ]]; then
  echo "TOC included non-message/non-task entries: $toc_unexpected" >&2
  exit 1
fi

toc_checkpoint_count="$(read_ab "count checkpoint toc entries" get count ".session-toc [data-compaction-checkpoint], .session-toc a[href^='#checkpoint-']")"
if [[ "$toc_checkpoint_count" != "0" ]]; then
  echo "Compaction checkpoints must not enter the ToC, got $toc_checkpoint_count" >&2
  exit 1
fi

thread_state="$(read_ab "verify conversation thread segments and toggle" eval "(() => { const messages = document.querySelector('#session-messages'); const stored = localStorage.getItem('agentsession.conversationView'); const expected = stored === 'thread' || stored === 'linear' ? stored : messages?.dataset.conversationDefault; const userSections = [...document.querySelectorAll('#session-messages > .thread-turn-user')]; return { defaultMode: messages?.dataset.conversationDefault, storedMode: stored, modeConsistent: messages?.classList.contains('conversation-' + expected), messageCount: messages?.dataset.conversationMessageCount, toggles: document.querySelectorAll('[data-conversation-view] [data-conversation-view-mode]').length, userSegments: userSections.length, userBlocks: document.querySelectorAll('#session-messages > .thread-turn-user > .thread-turn-content > .message-turn-user').length, userTurnsWithBlock: userSections.filter((section) => section.querySelector(':scope > .thread-turn-content > .message-turn-user')).length, checkpoints: document.querySelectorAll('[data-compaction-checkpoint]').length, uniqueCheckpointIds: new Set([...document.querySelectorAll('[data-compaction-checkpoint]')].map((el) => el.getAttribute('data-compaction-checkpoint'))).size }; })()")"
thread_state_compact="$(printf '%s' "$thread_state" | tr -d '[:space:]')"
if [[ "$thread_state_compact" == *"\"toggles\":0"* ]]; then
  echo "Conversation view toggle is missing: $thread_state" >&2
  exit 1
fi
assert_contains "conversation view mode follows the default" "$thread_state_compact" "\"modeConsistent\":true"
user_turn_blocks="$(echo "$thread_state_compact" | grep -o '"userBlocks":[0-9]*' | cut -d: -f2)"
user_turns_with_block="$(echo "$thread_state_compact" | grep -o '"userTurnsWithBlock":[0-9]*' | cut -d: -f2)"
user_turn_segments="$(echo "$thread_state_compact" | grep -o '"userSegments":[0-9]*' | cut -d: -f2)"
if [[ "$user_turn_blocks" != "$user_turns_with_block" ]]; then
  echo "Each top-level rendered user block should own exactly one thread turn, got blocks $user_turn_blocks turns-with-block $user_turns_with_block" >&2
  exit 1
fi
if [[ -n "$user_turn_blocks" && -n "$user_turn_segments" ]] && (( user_turn_segments < user_turn_blocks )); then
  echo "Thread user-turn segments should not be fewer than top-level rendered user blocks, got segments $user_turn_segments blocks $user_turn_blocks" >&2
  exit 1
fi
checkpoint_total="$(echo "$thread_state_compact" | grep -o '"checkpoints":[0-9]*' | cut -d: -f2)"
checkpoint_unique="$(echo "$thread_state_compact" | grep -o '"uniqueCheckpointIds":[0-9]*' | cut -d: -f2)"
if [[ "$checkpoint_unique" != "$checkpoint_total" ]]; then
  echo "Compaction checkpoints must render exactly once, got total $checkpoint_total unique $checkpoint_unique" >&2
  exit 1
fi

toggle_to_linear="$(read_ab "switch conversation view to Linear" eval "(() => { const btn = document.querySelector(\"[data-conversation-view-mode='linear']\"); const messages = document.querySelector('#session-messages'); if (!btn || !messages) return 'ready=false'; btn.click(); return [messages.className, 'pressed=' + btn.getAttribute('aria-pressed'), 'stored=' + localStorage.getItem('agentsession.conversationView')].join('|'); })()")"
if [[ "$toggle_to_linear" != *"ready=false"* ]]; then
  assert_contains "conversation toggle Linear" "$toggle_to_linear" "conversation-linear"
  assert_contains "conversation toggle Linear pressed" "$toggle_to_linear" "pressed=true"
  assert_contains "conversation toggle persisted" "$toggle_to_linear" "stored=linear"
fi
toggle_back_to_thread="$(read_ab "switch conversation view back to Thread" eval "(() => { const btn = document.querySelector(\"[data-conversation-view-mode='thread']\"); if (!btn) return 'ready=false'; btn.click(); return [document.querySelector('#session-messages')?.className, 'stored=' + localStorage.getItem('agentsession.conversationView')].join('|'); })()")"
if [[ "$toggle_back_to_thread" != *"ready=false"* ]]; then
  assert_contains "conversation toggle Thread" "$toggle_back_to_thread" "conversation-thread"
fi

# ── P2b: conversation inspector, references (guarded real-data assertions) ──
inspector_state="$(read_ab "verify P2b inspector" eval "(() => { const inspector = document.querySelector('[data-conversation-inspector]'); if (!inspector) return { present: false }; const sessionId = inspector.querySelector('[data-inspector-session-id]')?.textContent || ''; const width = window.innerWidth; const pos = getComputedStyle(inspector).position; const relCount = inspector.querySelectorAll('[data-inspector-relationships] .inspector-relationship').length; const moreLink = !!inspector.querySelector('[data-relationships-more]'); return { present: true, sessionId: sessionId.trim().length > 0, usage: !!inspector.querySelector('[data-inspector-usage]'), coverage: !!inspector.querySelector('[data-inspector-coverage]'), relationships: relCount, moreLink, relationshipConsistent: (relCount === 5 && moreLink) || (relCount < 5 && !moreLink), scopeGroups: [...inspector.querySelectorAll('[data-asset-scope]')].map((g) => g.dataset.assetScope), scopesPopulated: [...inspector.querySelectorAll('[data-asset-scope]')].every((g) => g.querySelectorAll('.inspector-asset').length > 0), positionedPerWidth: width > 1100 ? pos === 'sticky' : pos === 'static' }; })()" | tr -d '[:space:]')"
if [[ "$inspector_state" == *'"present":true'* ]]; then
  assert_contains "P2b inspector canonical session id" "$inspector_state" '"sessionId":true'
  assert_contains "P2b inspector usage" "$inspector_state" '"usage":true'
  assert_contains "P2b inspector coverage" "$inspector_state" '"coverage":true'
  assert_contains "P2b inspector responsive placement" "$inspector_state" '"positionedPerWidth":true'
  if [[ "$inspector_state" != *'"relationships":0'* && "$inspector_state" != *'"relationships":0,'* ]]; then
    assert_contains "P2b inspector relationship bound" "$inspector_state" '"relationshipConsistent":true'
  fi
  if [[ "$inspector_state" != *'"scopeGroups":[]'* ]]; then
    assert_contains "P2b inspector scopes populated" "$inspector_state" '"scopesPopulated":true'
  fi
fi

reference_state="$(read_ab "verify P2b references" eval "(() => { const rows = [...document.querySelectorAll('[data-agent-reference]')]; const ids = rows.map((el) => el.dataset.referenceId); return { count: rows.length, unique: new Set(ids).size === ids.length, knownKinds: rows.every((el) => ['dispatched', 'message', 'mailbox', 'result', 'acknowledgement'].includes(el.dataset.referenceKind)), tocContained: !document.querySelector('.session-toc [data-agent-reference], .session-toc [data-agent-card], .session-toc [data-agent-channel], .session-toc [data-channel-kind]') }; })()" | tr -d '[:space:]')"
if [[ "$reference_state" != *'"count":0'* && "$reference_state" != *'"count":0,'* && "$reference_state" != *'"count":0}'* ]]; then
  assert_contains "P2b reference uniqueness" "$reference_state" '"unique":true'
  assert_contains "P2b reference kinds" "$reference_state" '"knownKinds":true'
  assert_contains "P2b ToC coordination containment" "$reference_state" '"tocContained":true'
fi

toc_user_labels="$(read_ab "read user toc labels" get text ".session-toc .toc-user .toc-type")"
assert_contains "user toc labels" "$toc_user_labels" "U"

toc_agent_count="$(read_ab "count agent toc entries" get count ".session-toc .toc-assistant, .session-toc .toc-agent")"
if [[ "$toc_agent_count" != "0" ]]; then
  toc_agent_labels="$(read_ab "read agent toc labels" get text ".session-toc .toc-assistant .toc-type, .session-toc .toc-agent .toc-type")"
  assert_contains "agent toc labels" "$toc_agent_labels" "A"
fi

toc_task_count="$(read_ab "count task toc entries" get count ".session-toc .toc-task")"
if [[ "$toc_task_count" != "0" ]]; then
  toc_task_labels="$(read_ab "read task toc labels" get text ".session-toc .toc-task .toc-type")"
  assert_contains "task toc labels" "$toc_task_labels" "T"
fi

has_deep_toc_target="$(read_ab "activate deep toc entry" eval "(() => { const link = [...document.querySelectorAll('.session-toc .toc-link')].find((candidate) => candidate.closest('.toc-children .toc-children')); if (!link) return false; link.click(); return true; })()")"
if [[ "$has_deep_toc_target" == "true" ]]; then
  toc_parent_count="$(read_ab "count active toc parents" get count ".session-toc .toc-link.active-parent")"
  assert_positive_count "active toc parents" "$toc_parent_count"
  closed_toc_parent_count="$(read_ab "count hidden active toc parents" get count ".session-toc .toc-group:not([open]) .toc-link.active-parent")"
  if [[ "$closed_toc_parent_count" != "0" ]]; then
    echo "Active ToC parent path should stay expanded, got hidden parent count $closed_toc_parent_count" >&2
    exit 1
  fi
fi

reasoning_count="$(read_ab "count reasoning blocks" get count ".reasoning-block")"
assert_positive_count "reasoning blocks" "$reasoning_count"

message_reasoning_count="$(read_ab "count message reasoning blocks" get count ".message-reasoning .reasoning-block")"
turn_reasoning_count="$(read_ab "count assistant turn reasoning blocks" get count ".turn-reasoning .reasoning-block")"
tool_reasoning_count="$(read_ab "count tool reasoning blocks" get count ".tool-reasoning .reasoning-block")"
if [[ "$tool_reasoning_count" != "0" ]]; then
  echo "Reasoning should sit outside tool disclosures, got tool reasoning count $tool_reasoning_count" >&2
  exit 1
fi
subagent_reasoning_count="$(read_ab "count subagent reasoning blocks" get count ".subagent-reasoning .reasoning-block")"
attached_reasoning_count=$((message_reasoning_count + turn_reasoning_count + subagent_reasoning_count))
if [[ "$attached_reasoning_count" != "$reasoning_count" ]]; then
  echo "Reasoning blocks should attach to assistant/tool/task content, got total $reasoning_count attached $attached_reasoning_count" >&2
  exit 1
fi

message_toc_meta_count="$(read_ab "count message toc meta" get count ".toc-user .toc-meta, .toc-assistant .toc-meta, .toc-agent .toc-meta")"
if [[ "$message_toc_meta_count" != "0" ]]; then
  echo "Message ToC entries should not show timestamps/meta, got count $message_toc_meta_count" >&2
  exit 1
fi

token_chip_count="$(read_ab "count token chips" get count ".message-tokens .token-chip")"
assert_positive_count "token chips" "$token_chip_count"

reasoning_token_chip_count="$(read_ab "count separate reasoning token chips" get count ".message-tokens .token-chip-label >> text=R")"
if [[ "$reasoning_token_chip_count" != "0" ]]; then
  echo "Reasoning tokens should be merged into output chips, got separate chip count $reasoning_token_chip_count" >&2
  exit 1
fi

assistant_tool_count="$(read_ab "count tools nested in assistant turns" get count ".message-turn-assistant .tool-call")"
assert_positive_count "tools nested in assistant turns" "$assistant_tool_count"

top_level_tool_count="$(read_ab "count top-level tool calls" get count ".messages > .tool-call")"
if [[ "$top_level_tool_count" != "0" ]]; then
  echo "Ordinary tool calls should live inside assistant turns, got top-level count $top_level_tool_count" >&2
  exit 1
fi

legacy_topology_button_count="$(read_ab "count removed topology buttons" get count ".flow-open-btn")"
if [[ "$legacy_topology_button_count" != "0" ]]; then
  echo "Per-message topology buttons should remain removed, got $legacy_topology_button_count" >&2
  exit 1
fi

subagent_export_count="$(read_ab "count subagent export buttons" get count ".subagent-export-btn")"
assert_positive_count "subagent export buttons" "$subagent_export_count"

# P2b: sessions with recorded Task/AgentRun evidence render compact agent
# cards on the spine; sessions without a protocol binding keep the nested
# subagent blocks. Assert the path that is actually present (guarded).
agent_card_count="$(read_ab "count P2b agent cards" get count "details[data-agent-card]")"
agent_card_count_n="$(printf '%s' "$agent_card_count" | tr -dc '0-9')"
if [[ "$agent_card_count_n" != "0" ]]; then
  agent_card_state="$(read_ab "verify P2b agent card props" eval "(async () => { const cards = [...document.querySelectorAll('details[data-agent-card]')]; const f = cards[0]; const s = f?.querySelector(':scope > summary'); const before = { open: f?.hasAttribute('open'), ariaExpanded: s?.getAttribute('aria-expanded') }; s?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); const afterOpen = f?.hasAttribute('open'); const afterExpanded = s?.getAttribute('aria-expanded'); const channel = f?.querySelector('[data-agent-channel]'); const channelState = channel ? { present: true, collapsed: !channel.hasAttribute('open'), items: channel.querySelectorAll('.agent-channel-item').length, empty: !!channel.querySelector('.agent-channel-empty') } : { present: false }; const childLink = [...(f?.querySelectorAll('.subagent-export-btn') || [])].find((a) => a.getAttribute('href')?.includes('/session/')); s?.click(); await new Promise((resolve) => setTimeout(resolve, 0)); return { count: cards.length, defaultCollapsed: before.open === false, defaultAria: before.ariaExpanded === 'false', openedAfterToggle: afterOpen, expandedAfterToggle: afterExpanded === 'true', childLink: !!childLink, focusKept: document.activeElement === s, channelState, uniqueCards: new Set(cards.map((c) => c.dataset.agentCardId)).size === cards.length, named: cards.every((c) => (c.dataset.agentName || '').length > 0) }; })()" | tr -d '[:space:]')"
  assert_contains "P2b agent cards default collapsed" "$agent_card_state" '"defaultCollapsed":true'
  assert_contains "P2b agent cards toggle expanded" "$agent_card_state" '"openedAfterToggle":true'
  assert_contains "P2b agent cards aria-expanded" "$agent_card_state" '"expandedAfterToggle":true'
  assert_contains "P2b agent cards child link" "$agent_card_state" '"childLink":true'
  assert_contains "P2b agent cards focus preserved" "$agent_card_state" '"focusKept":true'
  assert_contains "P2b agent cards unique" "$agent_card_state" '"uniqueCards":true'
  if [[ "$agent_card_state" == *'"channelState":{"present":true'* ]]; then
    assert_contains "P2b channel default collapsed" "$agent_card_state" '"collapsed":true'
  fi
else
  subagent_summary_count="$(read_ab "count subagent headers" get count ".subagent-summary")"
  assert_positive_count "subagent headers" "$subagent_summary_count"

  subagent_token_count="$(read_ab "count subagent token groups" get count ".subagent-summary .subagent-tokens")"
  if [[ "$subagent_token_count" != "$subagent_summary_count" ]]; then
    echo "Each subagent header should show token usage, got tokens $subagent_token_count headers $subagent_summary_count" >&2
    exit 1
  fi
fi

# P2b truthful fallback: view-model cards without a transcript/part binding
# render exactly once in the explicit unplaced section (guarded; the section
# is absent when every card binds a real part).
unplaced_state="$(read_ab "verify P2b unplaced cards" eval "(() => { const section = document.querySelector('[data-agent-cards-unplaced]'); if (!section) return { present: false }; const ids = [...section.querySelectorAll('details[data-agent-card]')].map((el) => el.dataset.agentCardId); const pageIds = [...document.querySelectorAll('details[data-agent-card]')].map((el) => el.dataset.agentCardId); return { present: true, unique: new Set(ids).size === ids.length, exactlyOnce: ids.every((id) => pageIds.filter((x) => x === id).length === 1), allWithinMessages: !!section.closest('#session-messages'), tocFree: !document.querySelector('.session-toc [data-agent-card], .session-toc [data-agent-cards-unplaced], .session-toc [data-agent-channel]') }; })()" | tr -d '[:space:]')"
if [[ "$unplaced_state" == *'"present":true'* ]]; then
  assert_contains "P2b unplaced cards unique" "$unplaced_state" '"unique":true'
  assert_contains "P2b unplaced cards exactly once" "$unplaced_state" '"exactlyOnce":true'
  assert_contains "P2b unplaced cards on conversation surface" "$unplaced_state" '"allWithinMessages":true'
  assert_contains "P2b unplaced cards ToC containment" "$unplaced_state" '"tocFree":true'
fi

subagent_task_title_count="$(read_ab "count generic subagent task titles" get count ".subagent-summary >> text=Subagent task")"
if [[ "$subagent_task_title_count" != "0" ]]; then
  echo "Subagent headers should not show the generic Subagent task title, got count $subagent_task_title_count" >&2
  exit 1
fi

subagent_branch_word_count="$(read_ab "count subagent branch wording" get count ".subagent-summary >> text=branch")"
if [[ "$subagent_branch_word_count" != "0" ]]; then
  echo "Subagent headers should say session, not branch, got count $subagent_branch_word_count" >&2
  exit 1
fi

runtime_tab_click="$(read_ab "open Work tab" eval "(() => { const tab = document.getElementById('tab-btn-work'); if (!tab) return 'missing'; tab.click(); return 'clicked'; })()")"
if [[ "$runtime_tab_click" != "clicked" && "$runtime_tab_click" != '"clicked"' ]]; then
  echo "Runtime tab should open the workbench, got $runtime_tab_click" >&2
  exit 1
fi

runtime_tab_selected="$(read_ab "verify Work tab selection" get attr "#tab-btn-work" aria-selected)"
if [[ "$runtime_tab_selected" != "true" && "$runtime_tab_selected" != '"true"' ]]; then
  echo "Runtime tab should be selected after opening the workbench, got state $runtime_tab_selected" >&2
  exit 1
fi

runtime_root_count="$(read_ab "count runtime workbenches" get count "#tab-work .runtime-workbench[data-runtime-available='true']")"
if [[ "$runtime_root_count" != "1" ]]; then
  echo "Runtime tab should contain one available workbench, got $runtime_root_count" >&2
  exit 1
fi

runtime_workbench_main_count="$(read_ab "count unified runtime workbench" get count "#tab-work [data-runtime-workbench-main]")"
if [[ "$runtime_workbench_main_count" != "1" ]]; then
  echo "Work tab should expose one unified workbench surface, got $runtime_workbench_main_count" >&2
  exit 1
fi

runtime_section_ids="$(read_ab "read unified workbench sections" eval "[...document.querySelectorAll('#tab-work [data-runtime-section]')].map((node) => node.dataset.runtimeSection).join(',')")"
assert_contains "unified work section" "$runtime_section_ids" "runs"
assert_contains "coordination secondary disclosure" "$runtime_section_ids" "coordination"
assert_contains "context secondary disclosure" "$runtime_section_ids" "context"
runtime_work_visible="$(read_ab "verify Workbench visibility" eval "(() => { const panel = document.querySelector('#tab-work [data-runtime-workbench-main]'); return Boolean(panel && !panel.hidden && panel.getBoundingClientRect().height > 0); })()")"
if [[ "$runtime_work_visible" != "true" ]]; then
  echo "Workbench should be visible in the selected Work tab, got $runtime_work_visible" >&2
  exit 1
fi

# P3b guarded Work opening: providers without finalized v3 work evidence keep
# the explicit unavailable state, while available overviews expose the
# narrative, progress rule, current context result entry point, bounded task
# surface, and two bounded graph views.
runtime_overview_count="$(read_ab "count P3a work overviews" get count "#tab-work .runtime-workbench[data-runtime-available='true'] [data-runtime-work-overview]")"
if [[ "$runtime_overview_count" == "1" ]]; then
  p3a_overview_state="$(read_ab "verify P3b work overview" eval "(() => { const overview = document.querySelector('#tab-work [data-runtime-work-overview]'); const firstTask = overview?.querySelector('[data-runtime-overview-task]'); const contextHeading = overview?.querySelector('[data-runtime-context-heading]'); const headingCopy = contextHeading?.querySelector(':scope > div'); const coverage = contextHeading?.querySelector('.runtime-completeness'); const copyRect = headingCopy?.getBoundingClientRect(); const coverageRect = coverage?.getBoundingClientRect(); const headingCoverageSeparated = !copyRect || !coverageRect || coverageRect.top >= copyRect.bottom; const goalGraph = overview?.querySelector('[data-runtime-graph-panel=goal]'); const collaborationGraph = overview?.querySelector('[data-runtime-graph-panel=collaboration]'); const graphNodesBounded = [...overview?.querySelectorAll('[data-runtime-graph-panel]') || []].every((panel) => panel.querySelectorAll('[data-runtime-graph-node]').length <= 9); return { goal: !!overview?.querySelector('.runtime-work-goal'), progressRule: (overview?.querySelector('.runtime-progress-track')?.getBoundingClientRect().height || 0) === 5, context: !!overview?.querySelector('.runtime-context-inspector-link[data-detail-tab=tab-conversation]'), contextHeading: !!contextHeading, contextCoverageSeparated: headingCoverageSeparated, task: !!firstTask, goalGraph: !!goalGraph, collaborationGraph: !!collaborationGraph, graphNodesBounded, legacyRemoved: !overview?.querySelector('.runtime-legacy-work') }; })()" | tr -d '[:space:]')"
  assert_contains "P3a goal narrative" "$p3a_overview_state" '"goal":true'
  assert_contains "P3a five-pixel progress rule" "$p3a_overview_state" '"progressRule":true'
  assert_contains "P3a Conversation inspector entry point" "$p3a_overview_state" '"context":true'
  assert_contains "P3a context heading layout" "$p3a_overview_state" '"contextHeading":true'
  assert_contains "P3a context coverage layout" "$p3a_overview_state" '"contextCoverageSeparated":true'
  assert_contains "P3a bounded task table" "$p3a_overview_state" '"task":true'
  assert_contains "P3b goal/task graph" "$p3a_overview_state" '"goalGraph":true'
  assert_contains "P3b collaboration graph" "$p3a_overview_state" '"collaborationGraph":true'
  assert_contains "P3b graph node bound" "$p3a_overview_state" '"graphNodesBounded":true'
  assert_contains "P3b legacy relations removed" "$p3a_overview_state" '"legacyRemoved":true'
fi

ab "open Events tab" click "#tab-btn-events" >/dev/null
runtime_event_count="$(read_ab "count runtime events" get count "#tab-events [data-runtime-event]")"
assert_positive_count "runtime events" "$runtime_event_count"

runtime_evidence_count="$(read_ab "count runtime event evidence controls" get count "#tab-events [data-runtime-event-evidence-id]")"
assert_positive_count "runtime event evidence controls" "$runtime_evidence_count"
ab "reveal runtime event evidence" scrollintoview "#tab-events [data-runtime-event-evidence-id]" >/dev/null
ab "open runtime event evidence" click "#tab-events [data-runtime-event-evidence-id]" >/dev/null
runtime_drawer_open="$(read_ab "verify runtime event evidence drawer" eval "Boolean(document.querySelector('[data-runtime-events-drawer]')?.open)")"
if [[ "$runtime_drawer_open" != "true" ]]; then
  echo "Runtime evidence control should open the provenance drawer, got $runtime_drawer_open" >&2
  exit 1
fi
ab "close runtime evidence drawer" press Escape >/dev/null

ab "open Work tab" click "#tab-btn-work" >/dev/null
runtime_task_evidence_count="$(read_ab "count Work task evidence controls" get count "#tab-work [data-runtime-evidence-kind='task']")"
assert_positive_count "Work task evidence controls" "$runtime_task_evidence_count"
ab "reveal Work task selection" scrollintoview "#tab-work [data-runtime-select-kind='task']" >/dev/null
ab "select Work task" click "#tab-work [data-runtime-select-kind='task']" >/dev/null
runtime_selection_open="$(read_ab "verify Work selection inspector" eval "!document.querySelector('[data-runtime-inspector]').hidden")"
assert_contains "Work selection inspector" "$runtime_selection_open" "true"
ab "close Work selection with Escape" press Escape >/dev/null
runtime_selection_closed="$(read_ab "verify Work selection focus return" eval "document.querySelector('[data-runtime-inspector]').hidden && document.activeElement.dataset.runtimeSelectKind === 'task'")"
assert_contains "Work selection focus return" "$runtime_selection_closed" "true"
ab "open Work task evidence" click "#tab-work [data-runtime-evidence-kind='task']" >/dev/null
runtime_work_drawer_open="$(read_ab "verify Work evidence drawer" eval "Boolean(document.querySelector('#tab-work [data-runtime-drawer]')?.open)")"
if [[ "$runtime_work_drawer_open" != "true" ]]; then
  echo "Work task evidence control should open the provenance drawer, got $runtime_work_drawer_open" >&2
  exit 1
fi
ab "close Work evidence drawer" press Escape >/dev/null

ab "open Coordination disclosure" click "#tab-work [data-runtime-section='coordination'] > summary" >/dev/null
runtime_relationship_count="$(read_ab "count runtime relationship rows" get count "#tab-work .runtime-session-edge")"
assert_positive_count "runtime relationship rows" "$runtime_relationship_count"
runtime_session_link_count="$(read_ab "count canonical runtime session links" get count "#tab-work .runtime-session-edge a[href^='/opencode/session/']")"
assert_positive_count "canonical runtime session links" "$runtime_session_link_count"

toc_resize_count="$(read_ab "count toc resize handles" get count ".session-toc .toc-resize-handle")"
if [[ "$toc_resize_count" != "1" ]]; then
  echo "Session TOC should include one resize handle, got $toc_resize_count" >&2
  exit 1
fi

json_export="$(curl -fsS "$BASE/api/opencode/session/$SAMPLE_SESSION_ID/export?format=json")"
node -e "const data=JSON.parse(require('fs').readFileSync(0,'utf8')); if ('systemPrompts' in data) { process.exit(1); }" <<<"$json_export" || {
  echo "JSON export still included systemPrompts" >&2
  exit 1
}

md_export="$(curl -fsS "$BASE/api/opencode/session/$SAMPLE_SESSION_ID/export?format=md")"
assert_contains "markdown export" "$md_export" "### Reasoning"
assert_not_contains "markdown export" "$md_export" "System Prompts"

ab "set narrow P4c viewport" set viewport 320 768 >/dev/null
ab "set narrow P4c media" set media dark reduced-motion >/dev/null
ab "open narrow Library" open "$BASE/sessions" >/dev/null
ab "wait for narrow Library" wait --text "Library" >/dev/null
narrow_batch_state="$(read_ab "verify narrow batch touch targets" eval "(() => { const list = document.querySelector('#session-list'); const manage = document.querySelector('#toggle-batch'); manage?.click(); const card = document.querySelector('.session-card'); const hit = card?.querySelector('.card-checkbox-hit-area'); const checkbox = card?.querySelector('.card-checkbox'); const title = card?.querySelector('.session-card-title-link'); const selectAll = document.querySelector('.batch-select-all'); const rect = (node) => { const r = node?.getBoundingClientRect(); return r ? { width: r.width, height: r.height, right: r.right } : null; }; return JSON.stringify({ batch: list?.classList.contains('batch-mode'), overflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth, checkbox: rect(checkbox), checkboxName: checkbox?.getAttribute('aria-label') || '', hit: rect(hit), title: rect(title), selectAll: rect(selectAll), padding: getComputedStyle(card?.querySelector('.session-card-content')).paddingLeft }); })()")"
if ! printf '%s' "$narrow_batch_state" | grep -Eq 'batch[^a-z]*true' || ! printf '%s' "$narrow_batch_state" | grep -Eq 'overflow[^a-z]*true' || ! printf '%s' "$narrow_batch_state" | grep -Eq 'checkbox[^}]*height[^0-9]*1[5-9]|checkbox[^}]*width[^0-9]*1[5-9]' || ! printf '%s' "$narrow_batch_state" | grep -Eq 'checkboxName[^:]*:[^,}]*[^" ]' || ! printf '%s' "$narrow_batch_state" | grep -Eq 'hit[^}]*width[^0-9]*(4[4-9]|[5-9][0-9])' || ! printf '%s' "$narrow_batch_state" | grep -Eq 'selectAll[^}]*height[^0-9]*(4[4-9]|[5-9][0-9])'; then
  echo "Narrow Library batch mode should preserve the native checkbox and provide bounded 44px hit areas, got $narrow_batch_state" >&2
  exit 1
fi

ab "open narrow detail" open "$BASE/opencode/session/$SAMPLE_SESSION_ID" >/dev/null
ab "wait for narrow detail" wait --load networkidle >/dev/null
ab "open narrow transcript search" click "[data-session-search-toggle]" >/dev/null
narrow_search_state="$(read_ab "verify narrow transcript search containment" eval "(() => { const panel = document.querySelector('.session-search-panel'); const input = document.querySelector('[data-session-search-input]'); const navigation = document.querySelector('.session-search-navigation'); const buttons = [...document.querySelectorAll('.session-search-nav-btn')]; const rect = (node) => { const r = node?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; }; const p = rect(panel); const inside = (r) => Boolean(p && r && r.left >= p.left && r.right <= p.right && r.top >= p.top && r.bottom <= p.bottom); return JSON.stringify({ panel: p, input: rect(input), navigation: rect(navigation), buttons: buttons.map(rect), contained: inside(rect(input)) && inside(rect(navigation)) && buttons.every((button) => inside(rect(button))), visible: Boolean(input && navigation && buttons.length === 3 && input.getBoundingClientRect().width > 0 && navigation.getBoundingClientRect().height > 0), documentOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth }); })()")"
if ! printf '%s' "$narrow_search_state" | grep -Eq 'contained[^a-z]*true' || ! printf '%s' "$narrow_search_state" | grep -Eq 'visible[^a-z]*true' || ! printf '%s' "$narrow_search_state" | grep -Eq 'documentOverflow[^a-z]*true'; then
  echo "Narrow transcript search should keep its input and three navigation controls inside the fixed panel, got $narrow_search_state" >&2
  exit 1
fi

browser_errors="$(read_ab "collect browser errors" errors)"
ab "close session" close >/dev/null

node -e "console.log(JSON.stringify({ ok: true, base: process.argv[1], dbPath: process.argv[2], sampleSessionId: process.argv[3], browserErrors: process.argv[4] }, null, 2))" \
  "$BASE" "$DB_PATH" "$SAMPLE_SESSION_ID" "$browser_errors"
