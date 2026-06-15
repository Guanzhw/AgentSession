import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  ProviderId,
  RuntimeEnvironmentView,
  RuntimeExtensionKind,
  RuntimeExtensionReference,
  RuntimeExtensionScope
} from "../interface.js";

const MAX_RUNTIME_ENTRIES = 300;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "cache", "tmp"]);

function stableId(
  provider: ProviderId,
  scope: RuntimeExtensionScope,
  kind: RuntimeExtensionKind,
  source: string
) {
  const digest = createHash("sha256")
    .update(`${provider}\0${scope}\0${kind}\0${source}`)
    .digest("hex")
    .slice(0, 16);
  return `runtime:${provider}:${scope}:${kind}:${digest}`;
}

function usablePath(sourcePath: string | null) {
  if (!sourcePath || !existsSync(sourcePath)) {
    return null;
  }
  try {
    const stat = lstatSync(sourcePath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      return null;
    }
    return realpathSync(sourcePath);
  } catch {
    return null;
  }
}

export function runtimeInstructionFiles({
  provider,
  scope,
  files,
  note
}: {
  provider: ProviderId;
  scope: RuntimeExtensionScope;
  files: string[];
  note: string;
}) {
  return files
    .filter((filePath) => {
      const resolvedPath = usablePath(filePath);
      if (!resolvedPath) return false;
      try {
        return lstatSync(resolvedPath).isFile();
      } catch {
        return false;
      }
    })
    .map((filePath) => createRuntimeExtension({
      provider,
      scope,
      kind: "instruction",
      name: path.basename(filePath),
      source: path.resolve(filePath),
      sourcePath: filePath,
      sourceType: "file",
      note
    }));
}

export function createRuntimeExtension({
  provider,
  scope,
  kind,
  name,
  source,
  sourcePath = null,
  sourceType,
  defaultSelected = true,
  note = ""
}: {
  provider: ProviderId;
  scope: RuntimeExtensionScope;
  kind: RuntimeExtensionKind;
  name: string;
  source: string;
  sourcePath?: string | null;
  sourceType: RuntimeExtensionReference["sourceType"];
  defaultSelected?: boolean;
  note?: string;
}): RuntimeExtensionReference {
  const resolvedPath = usablePath(sourcePath);
  const available = sourceType === "package" || Boolean(resolvedPath);
  return {
    id: stableId(provider, scope, kind, source),
    provider,
    scope,
    kind,
    name,
    source,
    sourcePath: resolvedPath,
    sourceType,
    available,
    capturable: Boolean(resolvedPath),
    defaultSelected: defaultSelected && available,
    note
  };
}

function visibleEntries(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink() && !SKIPPED_DIRECTORIES.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

export function scanRuntimeChildren({
  provider,
  scope,
  kind,
  root,
  fileExtensions = [],
  markerFile = "",
  note = ""
}: {
  provider: ProviderId;
  scope: RuntimeExtensionScope;
  kind: RuntimeExtensionKind;
  root: string;
  fileExtensions?: string[];
  markerFile?: string;
  note?: string;
}): RuntimeExtensionReference[] {
  if (!existsSync(root)) {
    return [];
  }
  const suffixes = new Set(fileExtensions.map((entry) => entry.toLowerCase()));
  const result: RuntimeExtensionReference[] = [];
  for (const entry of visibleEntries(root)) {
    if (result.length >= MAX_RUNTIME_ENTRIES) break;
    const sourcePath = path.join(root, entry.name);
    if (entry.isDirectory() && markerFile && !existsSync(path.join(sourcePath, markerFile))) {
      continue;
    }
    if (entry.isFile() && suffixes.size && !suffixes.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }
    result.push(createRuntimeExtension({
      provider,
      scope,
      kind,
      name: entry.isDirectory() ? entry.name : path.basename(entry.name, path.extname(entry.name)),
      source: sourcePath,
      sourcePath,
      sourceType: entry.isDirectory() ? "directory" : "file",
      note
    }));
  }
  return result;
}

export function findProjectRoot(directory: string) {
  let current = path.resolve(directory);
  while (true) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(directory);
    }
    current = parent;
  }
}

export function projectDirectories(directory: string) {
  const start = path.resolve(directory);
  const root = findProjectRoot(start);
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result.reverse();
}

export function readJsonLike(filePath: string) {
  try {
    return JSON.parse(
      readFileSync(filePath, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/,\s*([}\]])/g, "$1")
    );
  } catch {
    return null;
  }
}

export function dedupeRuntimeExtensions(entries: RuntimeExtensionReference[]) {
  const result = new Map<string, RuntimeExtensionReference>();
  for (const entry of entries) {
    if (!result.has(entry.id)) {
      result.set(entry.id, entry);
    }
  }
  return [...result.values()]
    .sort((left, right) => (
      left.scope.localeCompare(right.scope)
      || left.kind.localeCompare(right.kind)
      || left.name.localeCompare(right.name)
      || left.source.localeCompare(right.source)
    ))
    .slice(0, MAX_RUNTIME_ENTRIES);
}

export function buildRuntimeEnvironment(
  sessionId: string,
  note: string,
  entries: RuntimeExtensionReference[]
): RuntimeEnvironmentView {
  return {
    sessionId,
    resolution: "current-local",
    note,
    extensions: dedupeRuntimeExtensions(entries)
  };
}
