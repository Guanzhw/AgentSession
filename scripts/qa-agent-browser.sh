#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${OPENSESSIONVIEWER_QA_PORT:-3470}"
DB_PATH="${OPENSESSIONVIEWER_QA_DB_PATH:-${SESSION_VIEWER_DB_PATH:-$HOME/.local/share/opencode/opencode.db}}"
SAMPLE_SESSION_ID="${OPENSESSIONVIEWER_QA_SESSION_ID:-ses_1ddf03616ffeTE5c6cbpUPMY3n}"
SESSION_NAME="${OPENSESSIONVIEWER_QA_BROWSER_SESSION:-opensessionviewer-qa-$PORT-$$}"
BASE="${OPENSESSIONVIEWER_QA_BASE_URL:-http://127.0.0.1:$PORT}"

mkdir -p "$ROOT/tmp" "$ROOT/logs"
export npm_config_cache="$ROOT/tmp/npm-cache"
NPX_CMD="${OPENSESSIONVIEWER_QA_NPX:-npx}"

cleanup() {
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" close --all >/dev/null 2>&1 || true
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
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" "$@"
}

read_ab() {
  local label="$1"
  shift
  local slug
  slug="$(printf '%s' "$label" | tr -cs 'A-Za-z0-9_-' '-' | tr 'A-Z' 'a-z')"
  local out="$ROOT/tmp/qa-agent-browser-$slug.out.txt"
  echo "[qa] agent-browser: $label" >&2
  "$NPX_CMD" --yes agent-browser --session "$SESSION_NAME" "$@" > "$out"
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

ab "open dashboard" open "$BASE/opencode" >/dev/null
ab "wait for dashboard" wait --text "Recent Sessions" >/dev/null
dashboard="$(read_ab "read dashboard" get text body)"
assert_contains "dashboard" "$dashboard" "Recent Sessions"
dashboard_session_ids="$(read_ab "count dashboard session ids" get count ".session-card .session-id")"
assert_positive_count "dashboard session ids" "$dashboard_session_ids"
dashboard_copy_buttons="$(read_ab "count dashboard copy buttons" get count ".session-card [data-action='copy-session-id']")"
assert_positive_count "dashboard session ID copy buttons" "$dashboard_copy_buttons"

ab "open stats" open "$BASE/opencode/stats" >/dev/null
ab "wait for stats" wait --text "Statistics Overview" >/dev/null
page_token_total="$(read_ab "read stats token total" get attr ".stats-summary-value[data-token-total]" data-token-total)"
api_token_total="$(curl -fsS "$BASE/api/opencode/stats" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(s).tokenTotal)))")"
if [[ "$page_token_total" != "$api_token_total" ]]; then
  echo "Stats page token total $page_token_total did not match API total $api_token_total" >&2
  exit 1
fi

ab "open search" open "$BASE/opencode/search?q=assistant" >/dev/null
ab "wait for search" wait --text "Search" >/dev/null

ab "open session detail" open "$BASE/opencode/session/$SAMPLE_SESSION_ID" >/dev/null
ab "wait for reasoning" wait --text "Reasoning" >/dev/null
detail="$(read_ab "read session detail" get text body)"
assert_not_contains "detail" "$detail" "System Prompts"
assert_contains "detail" "$detail" "Reasoning"
assert_contains "detail" "$detail" "Flow"
assert_contains "detail" "$detail" "TOOL"
assert_contains "detail session ID" "$detail" "$SAMPLE_SESSION_ID"

detail_session_id_count="$(read_ab "count detail session id" get count ".session-header .session-id")"
if [[ "$detail_session_id_count" != "1" ]]; then
  echo "Detail page should show one session ID below the title, got $detail_session_id_count" >&2
  exit 1
fi

resume_copy_count="$(read_ab "count resume command buttons" get count ".session-actions [data-action='copy-resume-command']")"
assert_positive_count "resume command buttons" "$resume_copy_count"
resume_launch_count="$(read_ab "count disabled-by-default terminal buttons" get count ".session-actions [data-action='resume-session']")"
if [[ "$resume_launch_count" != "0" ]]; then
  echo "Terminal launch button should be hidden without --allow-terminal-launch" >&2
  exit 1
fi
analysis_launch_count="$(read_ab "count disabled-by-default analysis buttons" get count ".session-actions [data-action='analyze-session']")"
if [[ "$analysis_launch_count" != "0" ]]; then
  echo "Session analysis button should be hidden without configured terminal launch" >&2
  exit 1
fi

toc_unexpected="$(read_ab "count unexpected toc entries" get count ".session-toc .toc-link:not(.toc-user):not(.toc-assistant):not(.toc-agent):not(.toc-task)")"
if [[ "$toc_unexpected" != "0" ]]; then
  echo "TOC included non-message/non-task entries: $toc_unexpected" >&2
  exit 1
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

deep_toc_target="$(read_ab "activate deep toc entry" eval "(() => { const link = [...document.querySelectorAll('.session-toc .toc-link')].find((candidate) => candidate.closest('.toc-children .toc-children')); if (!link) return ''; link.click(); return link.getAttribute('href') || ''; })()")"
if [[ -n "$deep_toc_target" ]]; then
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

flow_button_count="$(read_ab "count flow buttons" get count ".flow-open-btn")"
assert_positive_count "flow buttons" "$flow_button_count"

subagent_export_count="$(read_ab "count subagent export buttons" get count ".subagent-export-btn")"
assert_positive_count "subagent export buttons" "$subagent_export_count"

subagent_summary_count="$(read_ab "count subagent headers" get count ".subagent-summary")"
assert_positive_count "subagent headers" "$subagent_summary_count"

subagent_token_count="$(read_ab "count subagent token groups" get count ".subagent-summary .subagent-tokens")"
if [[ "$subagent_token_count" != "$subagent_summary_count" ]]; then
  echo "Each subagent header should show token usage, got tokens $subagent_token_count headers $subagent_summary_count" >&2
  exit 1
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

flow_panel_hidden="$(read_ab "count hidden flow panel" get count "#session-flow-panel.hidden")"
if [[ "$flow_panel_hidden" != "1" ]]; then
  echo "Flow panel should start hidden, got count $flow_panel_hidden" >&2
  exit 1
fi

flow_user_count="$(read_ab "count flow user nodes" get count "#session-flow-panel .flow-map-node-user")"
assert_positive_count "flow user nodes" "$flow_user_count"

flow_agent_count="$(read_ab "count flow agent nodes" get count "#session-flow-panel .flow-map-node-agent")"
assert_positive_count "flow agent nodes" "$flow_agent_count"

flow_agent_label_count="$(read_ab "count labeled flow agent nodes" get count "#session-flow-panel .flow-map-agent-label")"
if [[ "$flow_agent_label_count" != "$flow_agent_count" ]]; then
  echo "Every flow agent node should have a meaningful label, got agents $flow_agent_count labels $flow_agent_label_count" >&2
  exit 1
fi

flow_agent_mark_count="$(read_ab "count legacy A agent marks" get count "#session-flow-panel .flow-map-agent-mark")"
if [[ "$flow_agent_mark_count" != "0" ]]; then
  echo "Flow still included meaningless A agent marks: $flow_agent_mark_count" >&2
  exit 1
fi

flow_invocation_group_count="$(read_ab "count flow invocation groups" get count "#session-flow-panel .flow-map-fork-collapsed")"
assert_positive_count "flow invocation groups" "$flow_invocation_group_count"

flow_return_count="$(read_ab "count flow return nodes" get count "#session-flow-panel .flow-map-node-return")"
if [[ "$flow_return_count" != "$flow_invocation_group_count" ]]; then
  echo "Each compact invocation group should have one return node, got groups $flow_invocation_group_count returns $flow_return_count" >&2
  exit 1
fi

flow_branch_summary_count="$(read_ab "count flow branch summaries" get count "#session-flow-panel .flow-branch-summary[data-flow-branch-open]")"
assert_positive_count "flow branch summaries" "$flow_branch_summary_count"

flow_branch_template_count="$(read_ab "count flow branch templates" get count "#session-flow-panel template[data-flow-branch-template]")"
if [[ "$flow_branch_template_count" != "$flow_branch_summary_count" ]]; then
  echo "Each branch summary should have one detail template, got summaries $flow_branch_summary_count templates $flow_branch_template_count" >&2
  exit 1
fi

flow_expanded_branch_count="$(read_ab "count expanded flow branches in backbone" get count "#session-flow-panel .flow-map-root-session > .flow-map-line .flow-map-branches")"
if [[ "$flow_expanded_branch_count" != "0" ]]; then
  echo "Subagent detail should not expand inside the backbone, got $flow_expanded_branch_count expanded branches" >&2
  exit 1
fi

flow_branch_drawer_count="$(read_ab "count flow branch drawers" get count "#session-flow-panel [data-flow-branch-drawer]")"
if [[ "$flow_branch_drawer_count" != "1" ]]; then
  echo "Flow should include one reusable branch detail drawer, got $flow_branch_drawer_count" >&2
  exit 1
fi

flow_stat_count="$(read_ab "count flow summary stats" get count "#session-flow-panel .flow-map-stat")"
assert_positive_count "flow summary stats" "$flow_stat_count"

flow_overview_count="$(read_ab "count flow overview" get count "#session-flow-panel [data-flow-overview]")"
if [[ "$flow_overview_count" != "1" ]]; then
  echo "Flow should include one overview navigator, got $flow_overview_count" >&2
  exit 1
fi

flow_root_line_count="$(read_ab "count flow root lines" get count "#session-flow-panel .flow-map-root-session > .flow-map-line")"
if [[ "$flow_root_line_count" != "1" ]]; then
  echo "Flow should include one root line for responsive wrapping, got $flow_root_line_count" >&2
  exit 1
fi

toc_resize_count="$(read_ab "count toc resize handles" get count ".session-toc .toc-resize-handle")"
if [[ "$toc_resize_count" != "1" ]]; then
  echo "Session TOC should include one resize handle, got $toc_resize_count" >&2
  exit 1
fi

flow_timing_count="$(read_ab "count legacy flow timing rows" get count "#session-flow-panel .flow-timing-row")"
if [[ "$flow_timing_count" != "0" ]]; then
  echo "Flow still included legacy timing rows: $flow_timing_count" >&2
  exit 1
fi

flow_step_count="$(read_ab "count legacy flow step rows" get count ".flow-step")"
if [[ "$flow_step_count" != "0" ]]; then
  echo "Flow still included legacy step rows: $flow_step_count" >&2
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

ab "open CodeAgent route" open "$BASE/codeagent" >/dev/null
ab "wait for CodeAgent unavailable state" wait --text "Not installed" >/dev/null

browser_errors="$(read_ab "collect browser errors" errors)"
ab "close session" close >/dev/null

node -e "console.log(JSON.stringify({ ok: true, base: process.argv[1], dbPath: process.argv[2], sampleSessionId: process.argv[3], browserErrors: process.argv[4] }, null, 2))" \
  "$BASE" "$DB_PATH" "$SAMPLE_SESSION_ID" "$browser_errors"
