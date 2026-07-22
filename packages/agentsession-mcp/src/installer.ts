import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const AUTO_UPDATE_PACKAGE = "@acetamido/agentsession-mcp@latest";
export const MCP_SERVER_NAME = "agentsession";

export const installTargets = ["codex", "claude-code", "gemini", "opencode"] as const;
export type InstallTarget = (typeof installTargets)[number];

export interface InstallContext {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface Launcher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface InstallRequest extends InstallContext {
  configPath?: string;
  replace?: boolean;
  update?: boolean;
}

export interface InstallResult {
  configPath: string;
  status: "installed" | "updated" | "already-installed" | "needs-replace";
  target: InstallTarget;
}

export interface InstallerCommandOptions {
  configPath?: string;
  replace?: boolean;
  targets?: InstallTarget[];
  yes?: boolean;
}

function contextValue<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function getContext(context: InstallContext = {}) {
  return {
    cwd: contextValue(context.cwd, process.cwd()),
    env: contextValue(context.env, process.env),
    home: contextValue(context.home, homedir()),
    platform: contextValue(context.platform, process.platform)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfigPath(configPath: string | undefined, context: InstallContext): string | undefined {
  if (!configPath) return undefined;
  const { cwd } = getContext(context);
  const resolved = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  if (!existsSync(resolved)) {
    throw new Error(`AgentSession config file does not exist: ${resolved}`);
  }
  return resolved;
}

function commandExists(command: string, context: InstallContext): boolean {
  const { env, platform } = getContext(context);
  const pathValue = env.PATH || env.Path || "";
  const pathEntries = pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1"] : [""];
  return pathEntries.some((entry) => extensions.some((extension) => existsSync(join(entry, `${command}${extension}`))));
}

export function detectedInstallTargets(context: InstallContext = {}): InstallTarget[] {
  return installTargets.filter((target) => {
    if (target === "claude-code") return commandExists("claude", context);
    return commandExists(target, context);
  });
}

export function createAutoUpdateLauncher(configPath?: string, context: InstallContext = {}): Launcher {
  const { platform } = getContext(context);
  const npxArgs = [
    "--yes",
    "--prefer-online",
    AUTO_UPDATE_PACKAGE
  ];
  const launcher = platform === "win32"
    ? {
      command: "cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", `npx.cmd ${npxArgs.join(" ")}`]
    }
    : { command: "npx", args: npxArgs };

  return configPath
    ? { ...launcher, env: { AGENTSESSION_CONFIG: configPath } }
    : launcher;
}

export function getInstallConfigPath(target: InstallTarget, context: InstallContext = {}): string {
  const { cwd, env, home } = getContext(context);
  switch (target) {
    case "codex":
      return join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
    case "claude-code":
      return join(home, ".claude.json");
    case "gemini":
      return join(env.GEMINI_HOME || join(home, ".gemini"), "settings.json");
    case "opencode": {
      const configuredPath = env.OPENCODE_CONFIG;
      if (configuredPath) return isAbsolute(configuredPath) ? configuredPath : resolve(cwd, configuredPath);
      const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
      return join(configHome, "opencode", "opencode.json");
    }
  }
}

function readJsonConfig(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf8").trim();
  if (!source) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Cannot safely update ${filePath}: it is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Cannot safely update ${filePath}: its root value must be a JSON object.`);
  }
  return parsed;
}

function writeFileAtomically(filePath: string, content: string) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporaryPath, content, "utf8");
  try {
    renameSync(temporaryPath, filePath);
  } catch {
    // Windows can reject a rename over an opened config file. The new content was
    // already fully written to a sibling file, so use the direct write fallback.
    writeFileSync(filePath, content, "utf8");
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The replacement succeeded; a stale temporary file is safer than
      // incorrectly reporting that the selected host configuration was not saved.
    }
  }
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function sameStringRecord(value: unknown, expected: Record<string, string> | undefined): boolean {
  if (expected === undefined) return value === undefined;
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key]);
}

function hasOnlyProperties(entry: Record<string, unknown>, properties: string[]): boolean {
  return Object.keys(entry).every((property) => properties.includes(property));
}

function jsonEntryIsManaged(entry: unknown, launcher: Launcher): boolean {
  if (!isRecord(entry)) return false;
  return hasOnlyProperties(entry, ["command", "args", "env"])
    && entry.command === launcher.command
    && sameStringArray(entry.args, launcher.args)
    && sameStringRecord(entry.env, launcher.env);
}

function openCodeEntryIsManaged(entry: unknown, launcher: Launcher): boolean {
  if (!isRecord(entry)) return false;
  return hasOnlyProperties(entry, ["type", "command", "enabled", "environment"])
    && entry.type === "local"
    && entry.enabled === true
    && sameStringArray(entry.command, [launcher.command, ...launcher.args])
    && sameStringRecord(entry.environment, launcher.env);
}

function ensureObject(parent: Record<string, unknown>, property: string): Record<string, unknown> {
  const existing = parent[property];
  if (existing === undefined) {
    const next: Record<string, unknown> = {};
    parent[property] = next;
    return next;
  }
  if (isRecord(existing)) return existing;
  throw new Error(`Cannot safely update MCP configuration: ${property} must be a JSON object.`);
}

function upsertJsonEntry(
  filePath: string,
  property: "mcpServers" | "mcp",
  entry: Record<string, unknown>,
  replace: boolean,
  update: boolean,
  isManaged: (current: unknown) => boolean
): "installed" | "updated" | "already-installed" | "needs-replace" {
  const config = readJsonConfig(filePath);
  const servers = ensureObject(config, property);
  const current = servers[MCP_SERVER_NAME];
  if (current !== undefined && !replace) {
    if (!isManaged(current)) return "needs-replace";
    if (!update) return "already-installed";
  }
  servers[MCP_SERVER_NAME] = entry;
  writeFileAtomically(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return current === undefined ? "installed" : "updated";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTomlSection(source: string, header: string): { start: number; end: number; text: string } | undefined {
  const headerPattern = new RegExp(`^[\\t ]*\\[${escapeRegExp(header)}\\][\\t ]*(?:#.*)?(?:\\r?\\n|$)`, "gm");
  const match = headerPattern.exec(source);
  if (!match || match.index === undefined) return undefined;

  const start = match.index;
  const bodyStart = start + match[0].length;
  const tablePattern = /^[\t ]*\[([^\]]+)\][\t ]*(?:#.*)?(?:\r?\n|$)/gm;
  tablePattern.lastIndex = bodyStart;
  let end = source.length;
  let next: RegExpExecArray | null;
  while ((next = tablePattern.exec(source))) {
    const nextHeader = next[1].trim();
    if (nextHeader !== header && !nextHeader.startsWith(`${header}.`)) {
      end = next.index;
      break;
    }
  }
  return { start, end, text: source.slice(start, end) };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexSection(launcher: Launcher): string {
  const lines = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(launcher.command)}`,
    `args = [${launcher.args.map(tomlString).join(", ")}]`
  ];
  if (launcher.env) {
    const values = Object.entries(launcher.env).map(([key, value]) => `${key} = ${tomlString(value)}`);
    lines.push(`env = { ${values.join(", ")} }`);
  }
  lines.push("startup_timeout_sec = 120");
  return `${lines.join("\n")}\n`;
}

function tomlSectionIsManaged(section: string, expected: string): boolean {
  return section.replace(/\r\n/g, "\n").trim() === expected.replace(/\r\n/g, "\n").trim();
}

function upsertCodexConfig(filePath: string, launcher: Launcher, replace: boolean, update: boolean) {
  const source = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const header = `mcp_servers.${MCP_SERVER_NAME}`;
  const existing = findTomlSection(source, header);
  const section = buildCodexSection(launcher);
  if (existing && !replace) {
    if (!tomlSectionIsManaged(existing.text, section)) return "needs-replace";
    if (!update) return "already-installed";
  }
  const next = existing
    ? `${source.slice(0, existing.start)}${section}${source.slice(existing.end)}`
    : `${source.trimEnd()}${source.trimEnd() ? "\n\n" : ""}${section}`;
  writeFileAtomically(filePath, next);
  return existing ? "updated" : "installed";
}

export function installIntoTarget(target: InstallTarget, request: InstallRequest = {}): InstallResult {
  const configPath = normalizeConfigPath(request.configPath, request);
  const targetConfigPath = getInstallConfigPath(target, request);
  const launcher = createAutoUpdateLauncher(configPath, request);
  let status: InstallResult["status"];

  if (target === "codex") {
    status = upsertCodexConfig(targetConfigPath, launcher, Boolean(request.replace), Boolean(request.update));
  } else if (target === "claude-code" || target === "gemini") {
    const entry: Record<string, unknown> = {
      command: launcher.command,
      args: launcher.args
    };
    if (launcher.env) entry.env = launcher.env;
    status = upsertJsonEntry(
      targetConfigPath,
      "mcpServers",
      entry,
      Boolean(request.replace),
      Boolean(request.update),
      (current) => jsonEntryIsManaged(current, launcher)
    );
  } else {
    const entry: Record<string, unknown> = {
      type: "local",
      command: [launcher.command, ...launcher.args],
      enabled: true
    };
    if (launcher.env) entry.environment = launcher.env;
    status = upsertJsonEntry(
      targetConfigPath,
      "mcp",
      entry,
      Boolean(request.replace),
      Boolean(request.update),
      (current) => openCodeEntryIsManaged(current, launcher)
    );
  }

  return { target, configPath: targetConfigPath, status };
}

function parseTargets(value: string): InstallTarget[] {
  if (value === "all") return [...installTargets];
  const targets = value.split(",").map((target) => target.trim()).filter(Boolean);
  if (!targets.length) throw new Error("--target needs one or more target names.");
  const invalid = targets.filter((target) => !installTargets.includes(target as InstallTarget));
  if (invalid.length) {
    throw new Error(`Unsupported install target: ${invalid.join(", ")}. Choose from ${installTargets.join(", ")}, or all.`);
  }
  return [...new Set(targets as InstallTarget[])];
}

export function parseInstallerCommand(args: string[]): { action: "install" | "update"; options: InstallerCommandOptions } | undefined {
  const action = args[0];
  if (action !== "install" && action !== "update") return undefined;
  const options: InstallerCommandOptions = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target" || arg === "-t") {
      const targetValue = args[++index];
      if (!targetValue) throw new Error(`${arg} needs a value.`);
      options.targets = parseTargets(targetValue);
    } else if (arg === "--config") {
      const configPath = args[++index];
      if (!configPath) throw new Error("--config needs a path.");
      options.configPath = configPath;
    } else if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--help" || arg === "-h") {
      return undefined;
    } else {
      throw new Error(`Unknown installer option: ${arg}`);
    }
  }
  return { action, options };
}

function targetLabel(target: InstallTarget): string {
  switch (target) {
    case "codex": return "Codex";
    case "claude-code": return "Claude Code";
    case "gemini": return "Gemini CLI";
    case "opencode": return "OpenCode";
  }
}

async function chooseTargets(context: InstallContext, output: NodeJS.WriteStream): Promise<InstallTarget[]> {
  const detected = detectedInstallTargets(context);
  const candidates = detected.length ? detected : [...installTargets];
  output.write(`\nAvailable targets:\n${candidates.map((target, index) => `  ${index + 1}. ${targetLabel(target)}${detected.includes(target) ? " (detected)" : ""}`).join("\n")}\n`);
  const readline = createInterface({ input: process.stdin, output });
  try {
    const defaultValue = candidates.map((_, index) => String(index + 1)).join(",");
    const answer = (await readline.question(`Choose targets [${defaultValue}]: `)).trim();
    if (!answer) return candidates;
    const requested = answer.split(",").map((value) => value.trim()).filter(Boolean);
    const chosen = requested.map((value) => {
      const index = Number(value) - 1;
      if (!Number.isInteger(index) || !candidates[index]) throw new Error(`Unknown target selection: ${value}`);
      return candidates[index];
    });
    return [...new Set(chosen)];
  } finally {
    readline.close();
  }
}

async function confirm(message: string, output: NodeJS.WriteStream): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output });
  try {
    const answer = (await readline.question(`${message} [Y/n]: `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

function printResults(results: InstallResult[], output: NodeJS.WriteStream) {
  for (const result of results) {
    const label = targetLabel(result.target);
    if (result.status === "installed") output.write(`${label}: installed auto-updating MCP config at ${result.configPath}\n`);
    else if (result.status === "updated") output.write(`${label}: updated to the auto-updating MCP launcher at ${result.configPath}\n`);
    else if (result.status === "already-installed") output.write(`${label}: already uses the auto-updating MCP launcher.\n`);
    else output.write(`${label}: a custom or legacy ${MCP_SERVER_NAME} MCP entry already exists; rerun with --replace to overwrite it intentionally.\n`);
  }
}

export async function runInstallerCommand(
  action: "install" | "update",
  options: InstallerCommandOptions,
  context: InstallContext = {},
  output: NodeJS.WriteStream = process.stdout
): Promise<InstallResult[]> {
  let targets = options.targets;
  if (!targets) {
    if (!process.stdin.isTTY) {
      throw new Error("Interactive target selection needs a terminal. Re-run with --target codex,claude-code,gemini,opencode or --target all.");
    }
    targets = await chooseTargets(context, output);
  }

  const willReplace = Boolean(options.replace);
  if (!options.yes && process.stdin.isTTY) {
    const operation = willReplace
      ? "replace existing entries"
      : action === "update"
        ? "refresh installer-managed entries"
        : "install";
    const accepted = await confirm(`${operation} AgentSession-MCP for ${targets.map(targetLabel).join(", ")} with automatic npm updates?`, output);
    if (!accepted) return [];
  } else if (!options.yes && !process.stdin.isTTY) {
    throw new Error("Writing MCP configuration non-interactively requires --yes.");
  }

  const results = targets.map((target) => installIntoTarget(target, {
    ...context,
    configPath: options.configPath,
    replace: willReplace,
    update: action === "update"
  }));
  printResults(results, output);
  return results;
}

export function printInstallerHelp() {
  console.log(`AgentSession-MCP installer

Usage:
  agentsession-mcp install [options]
  agentsession-mcp update [options]

Options:
  -t, --target <hosts>  codex, claude-code, gemini, opencode, or all
      --config <path>   AgentSession config passed to the MCP through AGENTSESSION_CONFIG
      --replace         Intentionally replace an existing custom or legacy agentsession entry
  -y, --yes             Skip the confirmation prompt
  -h, --help            Show this help

The installed MCP uses npx --prefer-online ${AUTO_UPDATE_PACKAGE}, so every
Coding Agent startup checks npm for the latest published MCP before it connects.`);
}
