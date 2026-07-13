import { readFileSync } from "node:fs";
import type { Message, RawSession } from "../interface.js";
import { asNumber } from "../shared/parser.js";

export function claudeUsageToTokens(usage: any) {
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

/**
 * Claude writes one assistant response as multiple records when it contains
 * thinking, tool calls, or text. Every fragment repeats the same usage
 * payload, so token aggregation must retain one record per response instead
 * of summing each fragment.
 */
export function uniqueClaudeAssistantUsageRecords(records: any[]) {
  const uniqueRecords = [];
  const seenResponseIds = new Set<string>();
  let previousFallbackUsage = "";

  for (const record of records) {
    if (record.type !== "assistant") {
      previousFallbackUsage = "";
      continue;
    }

    const usage = record.message?.usage ?? record.usage;
    const tokens = claudeUsageToTokens(usage);
    if (!tokens) continue;

    const responseId = record.message?.id;
    if (typeof responseId === "string" && responseId) {
      if (seenResponseIds.has(responseId)) continue;
      seenResponseIds.add(responseId);
      previousFallbackUsage = "";
      uniqueRecords.push(record);
      continue;
    }

    const fallbackUsage = JSON.stringify(tokens);
    if (fallbackUsage === previousFallbackUsage) continue;
    previousFallbackUsage = fallbackUsage;
    uniqueRecords.push(record);
  }

  return uniqueRecords;
}

function contentBlocks(content: any) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function textFromContent(content: any) {
  return contentBlocks(content)
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function titleFromRecords(records: any) {
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

  const firstUser = records.find((record: any) => record.type === "user");
  const firstText = textFromContent(firstUser?.message?.content ?? firstUser?.content).trim();
  return firstText ? firstText.slice(0, 120) : null;
}

/**
 * Parse a Claude Code JSONL transcript file into records.
 * @param {string} filePath - Absolute path to .jsonl file
 * @returns {object[]} Parsed records
 */
export function parseTranscript(filePath: any, options: { strict?: boolean } = {}) {
  const content = readFileSync(filePath, "utf-8");
  const records = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      if (options.strict) {
        throw new Error(`Malformed Claude transcript line in ${filePath}`, { cause: err });
      }
      console.warn("Skipping malformed JSON line in:", filePath, err);
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
export function extractSessionMeta(records: any, sessionId: any): RawSession {
  let timeCreated = 0;
  let timeUpdated = 0;
  let totalTokens = 0;
  let directory = null;
  const sidechainRecord = records.find((record: any) => record.isSidechain);
  const canonicalId = sidechainRecord?.agentId || sessionId.replace(/^agent-/, "");
  const parentId = sidechainRecord?.isSidechain && sidechainRecord.sessionId !== canonicalId
    ? sidechainRecord.sessionId || null
    : null;

  for (const r of records) {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (ts && (!timeCreated || ts < timeCreated)) timeCreated = ts;
    if (ts > timeUpdated) timeUpdated = ts;

    if (r.type === "system" && r.cwd) directory = r.cwd;
    if (r.cwd && !directory) directory = r.cwd;

  }

  for (const record of uniqueClaudeAssistantUsageRecords(records)) {
    totalTokens += claudeUsageToTokens(record.message?.usage ?? record.usage)?.total || 0;
  }
  const messageCount = recordsToMessages(records, canonicalId).length;

  return {
    id: canonicalId,
    provider: "claude-code",
    parentId,
    title: sidechainRecord?.agentId || titleFromRecords(records),
    directory,
    timeCreated,
    timeUpdated,
    messageCount,
    tokenCount: totalTokens || null,
    metadata: sidechainRecord ? {
      agentId: sidechainRecord.agentId || canonicalId,
      aliases: [sidechainRecord.agentId, sessionId].filter(Boolean)
    } : null
  };
}

/**
 * Convert transcript records to unified Message[] format.
 * @param {object[]} records
 * @param {string} sessionId
 * @returns {import('../interface.js').Message[]}
 */
export function recordsToMessages(records: any, sessionId: any): Message[] {
  const messages = [];
  let msgIndex = 0;
  let pendingThinking = [];
  let assistantUsageKey = "";
  let assistantTokens = null;

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
      const turnId = r.message?.id || r.uuid || `assistant-${msgIndex}`;
      const tokens = claudeUsageToTokens(r.message?.usage ?? r.usage);
      const usageKey = JSON.stringify(tokens);
      if (usageKey !== assistantUsageKey) {
        assistantUsageKey = usageKey;
        assistantTokens = tokens;
      }

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
            tokens: assistantTokens,
            metadata: {
              model: r.message?.model || null,
              stopReason: r.message?.stop_reason || null,
              turnId
            }
          });
          pendingThinking = [];
          assistantTokens = null;
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
            tokens: assistantTokens,
            metadata: { model: r.message?.model || null, turnId, callId: block.id || null }
          });
          pendingThinking = [];
          assistantTokens = null;
        }
      }
      continue;
    }

    assistantUsageKey = "";
    assistantTokens = null;

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
        metadata: {
          isError: r.is_error || false,
          toolUseId: r.tool_use_id || r.toolUseId || null
        }
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
        metadata: {
          turnId: r.message?.id || r.parentUuid || r.uuid || `tool-${msgIndex}`,
          callId: r.tool_use_id || r.id || null
        }
      });
    }
  }

  return messages as Message[];
}
