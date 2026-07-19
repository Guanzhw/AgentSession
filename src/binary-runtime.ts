import { getAsset, isSea } from "node:sea";

export function isBinaryRuntime(): boolean {
  return isSea();
}

export function readBinaryAsset(key: string): string | null {
  if (!isBinaryRuntime()) return null;
  try {
    return getAsset(key, "utf8");
  } catch {
    return null;
  }
}
