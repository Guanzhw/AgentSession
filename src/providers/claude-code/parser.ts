import { readFileSync } from "node:fs";
import type { Message, RawSession } from "../interface.js";

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function usageToTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  const reasoning = asNumber(usage.reasoning_tokens);
  return {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
    total: asNumber(usage.total_tokens) || input + output + reasoning + cacheRead + cacheWrite
  };
}

function contentBlocks(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function textFromContent(content) {
  return contentBlocks(content)
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function titleFromRecords(records) {
  const custom = [...records].reverse().find((record) => (
    (record.type === "custom-title" || record.type === "custom_title") && record.customTitle
  ));
  if (custom?.customTitle) {
    return String(custom.customTitle).slice(0, 160);
  }

  const summary = [...records].reverse().find((record) => record.type === "summary" && record.summary);
  if (summary?.summary) {
    return String(summary.summary).slice(0, 160);
  }

  const firstUser = records.find((record) => record.type === "user");
  const firstText = textFromContent(firstUser?.message?.content ?? firstUser?.content).trim();
  return firstText ? firstText.slice(0, 120) : null;
}

/**
 * Parse a Claude Code JSONL transcript file into records.
 * @param {string} filePath - Absolute path to .jsonl file
 * @returns {object[]} Parsed records
 */
export function parseTranscript(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

/**
 * Extract session metadata from a transcript's records.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').RawSession}
 */
export function extractSessionMeta(records, sessionId): RawSession {
  let timeCreated = 0;
  let timeUpdated = 0;
  let messageCount = 0;
  let totalTokens = 0;
  let directory = null;

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (ts && (!timeCreated || ts < timeCreated)) timeCreated = ts;
    if (ts > timeUpdated) timeUpdated = ts;

    if (r.type === "user" || r.type === "assistant") messageCount++;
    if (r.type === "system" && r.cwd) directory = r.cwd;
    if (r.cwd && !directory) directory = r.cwd;

    if (r.type === "assistant") {
      const tokens = usageToTokens(r.message?.usage ?? r.usage);
      totalTokens += tokens?.total || 0;
    }
  }

  return {
    id: sessionId,
    provider: "claude-code",
    parentId: null,
    title: titleFromRecords(records),
    directory,
    timeCreated,
    timeUpdated,
    messageCount,
    tokenCount: totalTokens || null
  };
}

/**
 * Convert transcript records to unified Message[] format.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').Message[]}
 */
export function recordsToMessages(records, sessionId): Message[] {
  const messages = [];
  let msgIndex = 0;

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;

    if (r.type === "user") {
      const blocks = contentBlocks(r.message?.content ?? r.content);
      const text = textFromContent(blocks);
      if (text) {
        messages.push({
          id: r.uuid || `msg-${msgIndex++}`,
          sessionId,
          role: "user",
          content: text,
          thinking: null,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          timestamp: ts,
          tokens: null,
          metadata: { version: r.version, cwd: r.cwd }
        });
      }

      // Current Claude Code transcripts embed tool results as blocks inside a
      // user record rather than emitting a standalone tool_result record.
      for (const block of blocks.filter((item) => item?.type === "tool_result")) {
        const rawContent = block.content ?? block.tool_output ?? "";
        messages.push({
          id: block.tool_use_id || `tool-result-${msgIndex++}`,
          sessionId,
          role: "tool",
          content: typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent),
          thinking: null,
          toolName: block.tool_name || "tool_result",
          toolInput: null,
          toolOutput: rawContent,
          timestamp: ts,
          tokens: null,
          metadata: { isError: Boolean(block.is_error), toolUseId: block.tool_use_id || null }
        });
      }
    }

    if (r.type === "assistant") {
      const blocks = contentBlocks(r.message?.content ?? r.content);
      const tokens = usageToTokens(r.message?.usage ?? r.usage);
      let pendingThinking = [];
      let usageAttached = false;

      for (const block of blocks) {
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          pendingThinking.push(block.thinking || block.data || "[Redacted thinking]");
          continue;
        }
        if (block.type === "text" && block.text) {
          messages.push({
            id: r.uuid ? `${r.uuid}:${msgIndex++}` : `msg-${msgIndex++}`,
            sessionId,
            role: "assistant",
            content: block.text,
            thinking: pendingThinking.join("\n\n") || null,
            toolName: null,
            toolInput: null,
            toolOutput: null,
            timestamp: ts,
            tokens: usageAttached ? null : tokens,
            metadata: {
              model: r.message?.model || null,
              stopReason: r.message?.stop_reason || null
            }
          });
          pendingThinking = [];
          usageAttached = true;
          continue;
        }
        if (block.type === "tool_use") {
          messages.push({
            id: block.id || `tool-${msgIndex++}`,
            sessionId,
            role: "tool",
            content: "",
            thinking: pendingThinking.join("\n\n") || null,
            toolName: block.name || "unknown",
            toolInput: block.input || null,
            toolOutput: null, // output comes from tool_result records
            timestamp: ts,
            tokens: usageAttached ? null : tokens,
            metadata: { model: r.message?.model || null }
          });
          pendingThinking = [];
          usageAttached = true;
        }
      }
    }

    if (r.type === "tool_result") {
      const rawContent = r.tool_output ?? r.content;
      const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent || "");
      messages.push({
        id: `tool-result-${msgIndex++}`,
        sessionId,
        role: "tool",
        content: content.slice(0, 5000), // Truncate long tool outputs
        thinking: null,
        toolName: r.tool_name || "tool_result",
        toolInput: null,
        toolOutput: rawContent,
        timestamp: ts,
        tokens: null,
        metadata: { isError: r.is_error || false }
      });
    }
    if (r.type === "tool_use") {
      messages.push({
        id: r.uuid || `tool-${msgIndex++}`,
        sessionId,
        role: "tool",
        content: "",
        thinking: null,
        toolName: r.tool_name || r.name || "unknown",
        toolInput: r.tool_input || r.input || null,
        toolOutput: null,
        timestamp: ts,
        tokens: null,
        metadata: null
      });
    }
  }

  return messages;
}
