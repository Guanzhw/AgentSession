import { parseJson } from "../shared/parser.js";

type Row = Record<string, any>;

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function enrichCodeAgentSession(session: Row, messages: Row[]) {
  const assistantMessages = messages
    .map((message) => typeof message.data === "string" ? parseJson(message.data) : message.data)
    .filter((data) => data && data.role === "assistant");
  const latest = assistantMessages.at(-1) || {};
  const usage = assistantMessages.reduce((totals, data) => {
    const tokens = data.tokens || {};
    const cache = tokens.cache || {};
    totals.tokens_input += asNumber(tokens.input);
    totals.tokens_output += asNumber(tokens.output);
    totals.tokens_reasoning += asNumber(tokens.reasoning);
    totals.tokens_cache_read += asNumber(cache.read);
    totals.tokens_cache_write += asNumber(cache.write);
    totals.cost += asNumber(data.cost);
    return totals;
  }, {
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    cost: 0
  });

  const modelId = latest.modelID || latest.model?.modelID || null;
  const providerId = latest.providerID || latest.model?.providerID || null;

  return {
    ...session,
    agent: latest.agent || latest.mode || null,
    model: providerId && modelId ? `${providerId}/${modelId}` : modelId,
    ...usage
  };
}
