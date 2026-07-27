import type { TokenUsage } from "../interface.js";
import { asNumber } from "./parser.js";

/**
 * A provider may report an authoritative request total without every component
 * required by the UI breakdown. Keep that source total when aggregating rather
 * than recomputing it from the partial fields.
 */
export function tokenUsageTotal(tokens: TokenUsage | null | undefined): number {
  if (!tokens) return 0;
  return asNumber(tokens.total) || (
    asNumber(tokens.input)
    + asNumber(tokens.output)
    + asNumber(tokens.reasoning)
    + asNumber(tokens.cache?.read)
    + asNumber(tokens.cache?.write)
  );
}

export function emptyTokenUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    cache: { read: 0, write: 0 }
  };
}

export function cloneTokenUsage(tokens: TokenUsage | null | undefined): TokenUsage {
  return {
    input: asNumber(tokens?.input),
    output: asNumber(tokens?.output),
    reasoning: asNumber(tokens?.reasoning),
    total: asNumber(tokens?.total),
    cache: {
      read: asNumber(tokens?.cache?.read),
      write: asNumber(tokens?.cache?.write)
    }
  };
}

export function addTokenUsage(total: TokenUsage, tokens: TokenUsage | null | undefined): TokenUsage {
  const currentTotal = tokenUsageTotal(total);
  const sourceTotal = tokenUsageTotal(tokens);
  total.input = asNumber(total.input) + asNumber(tokens?.input);
  total.output = asNumber(total.output) + asNumber(tokens?.output);
  total.reasoning = asNumber(total.reasoning) + asNumber(tokens?.reasoning);
  total.cache = {
    read: asNumber(total.cache?.read) + asNumber(tokens?.cache?.read),
    write: asNumber(total.cache?.write) + asNumber(tokens?.cache?.write)
  };
  total.total = currentTotal + sourceTotal;
  return total;
}

export function sumTokenUsage(values: Iterable<TokenUsage | null | undefined>): TokenUsage {
  const total = emptyTokenUsage();
  for (const tokens of values) {
    addTokenUsage(total, tokens);
  }
  return total;
}

export function aggregateTokenUsageTree<T>(
  root: T,
  readTokens: (node: T) => Iterable<TokenUsage | null | undefined>,
  readChildren: (node: T) => Iterable<T>
): TokenUsage {
  const total = emptyTokenUsage();
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    for (const tokens of readTokens(node)) {
      addTokenUsage(total, tokens);
    }
    for (const child of readChildren(node)) {
      pending.push(child);
    }
  }
  return total;
}
