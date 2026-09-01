import type { TokenUsage } from "../interface.js";
import type { SessionContainer } from "./session-container.js";
import type { SessionTree } from "./session-tree.js";
import { aggregateTokenUsageTree, sumTokenUsage } from "./token-usage.js";

export function aggregateSessionTreeDirectTokenUsage(tree: SessionTree): TokenUsage {
  return sumTokenUsage(tree.messages.map((message) => message.data?.tokens as TokenUsage | null));
}

export function aggregateSessionContainerDirectTokenUsage(container: SessionContainer): TokenUsage {
  return sumTokenUsage(container.messages.map((message) => message.data?.tokens as TokenUsage | null));
}

export function aggregateSessionTreeTokenUsage(tree: SessionTree): TokenUsage {
  return aggregateTokenUsageTree(
    tree,
    (node) => node.messages.map((message) => message.data?.tokens as TokenUsage | null),
    (node) => [
      ...node.messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions)),
      ...node.detachedChildren
    ]
  );
}

export function aggregateSessionContainerTokenUsage(container: SessionContainer): TokenUsage {
  return aggregateTokenUsageTree(
    container,
    (node) => node.messages.map((message) => message.data?.tokens as TokenUsage | null),
    (node) => [
      ...node.messages.flatMap((message) => message.parts.flatMap((part) => part.childSessions)),
      ...node.detachedChildren
    ]
  );
}
