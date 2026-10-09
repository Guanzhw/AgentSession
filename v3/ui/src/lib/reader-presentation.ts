import type { ReaderEventRef, ReaderItem } from './api';
import type { DisplayItem } from './EventCard.svelte';

export interface ReaderBlock { main: DisplayItem; thinking: DisplayItem[]; tools: ReaderBlock[] }
export interface ProcessUnit { id: number | null; blocks: ReaderBlock[]; count: number; totalCount: number; lastOrdinal: number }

function eventKey(event: ReaderEventRef): string {
  return JSON.stringify([event.provider, event.sessionId, event.messageId, event.segment]);
}

export function groupReaderItems(sourceItems: ReaderItem[], display: (item: ReaderItem) => DisplayItem): ReaderBlock[] {
  const result: ReaderBlock[] = [];
  const sourceBlocks = sourceItems.map(item => ({ main: display(item), thinking: [], tools: [] }) as ReaderBlock);
  const owners = new Map<string, ReaderBlock>();
  for (const block of sourceBlocks) {
    const { item } = block.main;
    if ((item.role === 'assistant' && item.event.segment === 'message') || item.role === 'tool') {
      owners.set(block.main.key, block);
    }
  }
  for (const block of sourceBlocks) {
    const { item } = block.main;
    const owner = item.owner ? owners.get(eventKey(item.owner)) : undefined;
    if (item.event.segment === 'thinking' && owner && item.processId === owner.main.item.processId) {
      owner.thinking.push(block.main);
    } else if (item.role === 'tool' && owner?.main.item.role === 'assistant' && owner.main.item.event.segment === 'message' && item.processId === owner.main.item.processId) {
      owner.tools.push(block);
    } else {
      result.push(block);
    }
  }
  return result;
}

export function groupReaderProcesses(source: ReaderBlock[]): ProcessUnit[] {
  const units: ProcessUnit[] = [];
  const totals = new Map<ProcessUnit, Map<number | string, number>>();
  const count = (block: ReaderBlock): number => 1 + block.thinking.length +
    block.tools.reduce((total, tool) => total + count(tool), 0);
  const lastOrdinal = (block: ReaderBlock): number => Math.max(block.main.item.ordinal,
    ...block.thinking.map(thought => thought.item.ordinal),
    ...block.tools.map(tool => lastOrdinal(tool)));
  for (const block of source) {
    const id = block.main.item.processId ?? null;
    const previous = units[units.length - 1];
    const hidden = id !== null || block.main.item.event.segment === 'thinking';
    const previousHidden = previous && (previous.id !== null || previous.blocks[0].main.item.event.segment === 'thinking');
    const processKey = id ?? block.main.key;
    const total = block.main.item.processCount ?? count(block);
    if (hidden && previousHidden && previous.lastOrdinal + 1 === block.main.item.ordinal) {
      previous.blocks.push(block);
      previous.count += count(block);
      const counts = totals.get(previous)!;
      counts.set(processKey, Math.max(counts.get(processKey) ?? 0, total));
      previous.totalCount = [...counts.values()].reduce((sum, value) => sum + value, 0);
      previous.lastOrdinal = lastOrdinal(block);
    } else {
      const unit = { id, blocks: [block], count: count(block), totalCount: total, lastOrdinal: lastOrdinal(block) };
      units.push(unit);
      totals.set(unit, new Map([[processKey, total]]));
    }
  }
  return units;
}
