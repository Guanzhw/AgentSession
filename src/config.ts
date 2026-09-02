import os from "node:os";
import path from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Try multiple candidate paths, return the first that exists on disk.
 * Falls back to fallback (or second candidate) if none exist.
 * @param {string[]} candidates
 * @param {string} [fallback]
 * @returns {string}
 */
function probePaths(candidates: any, fallback: any) {
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return fallback || candidates[1] || candidates[0];
}

function defaultDbPath() {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const fallback = path.join(xdgData, "opencode", "opencode.db");
  const candidates = [
    process.env.AGENTSESSION_DB_PATH,
    fallback,
  ];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "opencode", "opencode.db"));
  }
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "opencode", "opencode.db"));
  }
  return probePaths(candidates.filter(Boolean), fallback);
}

function defaultMetaDir() {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "agentsession")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentsession");
}

function defaultClaudeDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".claude");
  const candidates = [process.env.CLAUDE_CONFIG_DIR, fallback];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "claude"));
  }
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "claude"));
  }
  return probePaths(candidates.filter(Boolean), fallback);
}

function defaultCodexDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".codex");
  const candidates = [process.env.CODEX_HOME, fallback];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "codex"));
  }
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "codex"));
  }
  return probePaths(candidates.filter(Boolean), fallback);
}

function defaultPiDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".pi", "agent");
  return probePaths([process.env.PI_CODING_AGENT_DIR, fallback].filter(Boolean), fallback);
}

function defaultDshDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".dsh");
  const configured = process.env.DSH_HOME?.trim();
  return probePaths([configured, fallback].filter(Boolean), fallback);
}

function defaultOpenClawDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".openclaw");
  return probePaths([process.env.OPENCLAW_STATE_DIR, process.env.OPENCLAW_HOME && path.join(process.env.OPENCLAW_HOME, ".openclaw"), fallback].filter(Boolean), fallback);
}

function defaultHermesDir() {
  const home = os.homedir();
  const fallback = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "hermes")
    : path.join(home, ".hermes");
  return probePaths([process.env.HERMES_HOME, fallback].filter(Boolean), fallback);
}

const defaults = {
  port: 3456,
  dbPath: defaultDbPath(),
  metaDir: defaultMetaDir(),
  lang: "en",
  open: false,
  claudeDir: defaultClaudeDir(),
  codexDir: defaultCodexDir(),
  piDir: defaultPiDir(),
  dshDir: defaultDshDir(),
  openclawDir: defaultOpenClawDir(),
  hermesDir: defaultHermesDir(),
  reindex: false,
  allowTerminalLaunch: true,
  mcp: {
    searchLimit: 20,
    timelineLimit: 50,
    eventMaxChars: 4000,
    contextWindow: 5
  },
};

function isObject(value: any) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readUserConfigDocument(configPath: any) {
  if (!configPath || !existsSync(configPath)) {
    return {
      exists: false,
      raw: "{}\n",
      config: {},
      error: ""
    };
  }

  let raw = "";
  try {
    raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) {
      return {
        exists: true,
        raw,
        config: {},
        error: "Configuration root must be a JSON object."
      };
    }
    return {
      exists: true,
      raw,
      config: normalizeUserConfig(parsed),
      error: ""
    };
  } catch (error: any) {
    return {
      exists: true,
      raw,
      config: {},
      error: error.message
    };
  }
}

export function readUserConfig(configPath: any) {
  const document = readUserConfigDocument(configPath);
  if (document.error) {
    console.warn(`Ignoring invalid AgentSession config at ${configPath}: ${document.error}`);
  }
  return document.config;
}

function validateStringArray(value: any, field: any, errors: any) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings.`);
  }
}

function validateStringMap(value: any, field: string, errors: any[]) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object of string values.`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || typeof item !== "string" || !item.trim()) {
      errors.push(`${field} entries must use non-empty string keys and values.`);
      return;
    }
  }
}

function validateProjectPathMap(value: any, field: string, errors: any[]) {
  validateStringMap(value, field, errors);
  if (!isObject(value)) return;
  for (const [key, directory] of Object.entries(value)) {
    if (typeof directory === "string" && directory.trim() && !path.isAbsolute(directory)) {
      errors.push(`${field}.${key} must be an absolute path.`);
      return;
    }
  }
}

function normalizeProjectPaths(config: any) {
  const projectPaths: Record<string, Record<string, string>> = {};
  const copy = (value: any, overwrite = true) => {
    if (!isObject(value)) return;
    for (const [provider, mapping] of Object.entries(value)) {
      if (!isObject(mapping)) continue;
      const target = projectPaths[provider] || (projectPaths[provider] = {});
      for (const [key, directory] of Object.entries(mapping as any)) {
        if (typeof key === "string" && key.trim() && typeof directory === "string" && directory.trim()) {
          if (overwrite || target[key] === undefined) target[key] = directory;
        }
      }
    }
  };
  copy(config?.projectPaths);
  // Legacy compatibility is read-only. Only opaque project mappings survive;
  // the old analyzer configuration is never exposed or persisted.
  const providers = config?.analysis?.providers;
  if (isObject(providers)) {
    for (const [provider, settings] of Object.entries(providers)) {
      copy({ [provider]: (settings as any)?.projectPaths }, false);
    }
  }
  return projectPaths;
}

function normalizeUserConfig(config: any) {
  const normalized = isObject(config) ? { ...config } : {};
  normalized.projectPaths = normalizeProjectPaths(config);
  delete normalized.projectPaths.copilot;
  delete normalized.projectPaths.gemini;
  if (isObject(normalized.resumeCommands)) {
    normalized.resumeCommands = { ...normalized.resumeCommands };
    delete normalized.resumeCommands.copilot;
    delete normalized.resumeCommands.gemini;
  }
  delete normalized.copilotDir;
  delete normalized.geminiDir;
  delete normalized.analysis;
  return normalized;
}

function validateShell(value: any, field: any, errors: any) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object.`);
    return;
  }
  if (value.executable !== undefined && (typeof value.executable !== "string" || !value.executable.trim())) {
    errors.push(`${field}.executable must be a non-empty string.`);
  }
  if (value.args !== undefined) {
    validateStringArray(value.args, `${field}.args`, errors);
  }
}

function validateCommand(value: any, field: any, errors: any) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object.`);
    return;
  }
  if (typeof value.executable !== "string" || !value.executable.trim()) {
    errors.push(`${field}.executable must be a non-empty string.`);
  }
  if (!Array.isArray(value.args) || value.args.some((item: any) => typeof item !== "string")) {
    errors.push(`${field}.args must be an array of strings.`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    errors.push(`${field}.cwd must be a string.`);
  }
  if (value.stdin !== undefined && value.stdin !== "prompt") {
    errors.push(`${field}.stdin must be "prompt" when provided.`);
  }
}

const MCP_LIMIT_FIELDS = {
  searchLimit: { max: 100 },
  timelineLimit: { max: 200 },
  eventMaxChars: { max: 20000 },
  contextWindow: { max: 20 }
};

export function normalizeMcpConfig(value: any = undefined) {
  const configured = isObject(value) ? value : {};
  const normalized: Record<string, number> = {};
  for (const [field, rule] of Object.entries(MCP_LIMIT_FIELDS)) {
    const candidate = configured[field];
    const fallback = (defaults.mcp as any)[field];
    normalized[field] = Number.isInteger(candidate) && candidate > 0
      ? Math.min(candidate, rule.max)
      : fallback;
  }
  return normalized;
}

function validateMcpConfig(value: any, field: string, errors: any[]) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object.`);
    return;
  }
  for (const [name, rule] of Object.entries(MCP_LIMIT_FIELDS)) {
    const candidate = value[name];
    if (candidate !== undefined && (!Number.isInteger(candidate) || candidate <= 0 || candidate > rule.max)) {
      errors.push(`${field}.${name} must be a positive integer no greater than ${rule.max}.`);
    }
  }
}

export function validateUserConfig(config: any) {
  const errors: any[] = [];
  if (!isObject(config)) {
    return ["Configuration root must be a JSON object."];
  }

  if (config.resumeCommands !== undefined) {
    if (!isObject(config.resumeCommands)) {
      errors.push("resumeCommands must be an object.");
    } else {
      for (const [provider, command] of Object.entries(config.resumeCommands)) {
        if (command !== false) {
          validateCommand(command, `resumeCommands.${provider}`, errors);
        }
      }
    }
  }

  if (config.resumeShell !== undefined && config.resumeShell !== null) {
    validateShell(config.resumeShell, "resumeShell", errors);
  }

  if (config.mcp !== undefined) {
    validateMcpConfig(config.mcp, "mcp", errors);
  }

  if (config.projectPaths !== undefined) {
    if (!isObject(config.projectPaths)) {
      errors.push("projectPaths must be an object mapping providers to project maps.");
    } else {
      for (const [providerId, mapping] of Object.entries(config.projectPaths)) {
        validateProjectPathMap(mapping, `projectPaths.${providerId}`, errors);
      }
    }
  }

  // Token pricing validation
  if (config.tokenPricing !== undefined) {
    if (!isObject(config.tokenPricing) || Array.isArray(config.tokenPricing)) {
      errors.push("tokenPricing must be an object mapping model keys to pricing entries.");
    } else {
      for (const [key, entry] of Object.entries(config.tokenPricing as Record<string, unknown>)) {
        if (!key.includes("/") || key.startsWith("/") || key.endsWith("/")) {
          errors.push(`tokenPricing.${key} key must use provider/model format.`);
        }
        if (!isObject(entry)) {
          errors.push(`tokenPricing.${key} must be an object.`);
          continue;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.currency !== "string" || !/^[A-Za-z]{3}$/.test(e.currency.trim())) {
          errors.push(`tokenPricing.${key}.currency must be a three-letter ISO 4217 code.`);
        }
        if (typeof e.inputPerMillion !== "number" || !Number.isFinite(e.inputPerMillion) || (e.inputPerMillion as number) < 0) {
          errors.push(`tokenPricing.${key}.inputPerMillion must be a finite non-negative number.`);
        }
        if (typeof e.outputPerMillion !== "number" || !Number.isFinite(e.outputPerMillion) || (e.outputPerMillion as number) < 0) {
          errors.push(`tokenPricing.${key}.outputPerMillion must be a finite non-negative number.`);
        }
        for (const f of ["reasoningPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"]) {
          if (e[f] !== undefined && (typeof e[f] !== "number" || !Number.isFinite(e[f]) || (e[f] as number) < 0)) {
            errors.push(`tokenPricing.${key}.${f} must be a finite non-negative number when provided.`);
          }
        }
        if (e.sourceLabel !== undefined && (typeof e.sourceLabel !== "string" || e.sourceLabel.length > 200)) {
          errors.push(`tokenPricing.${key}.sourceLabel must be a string of at most 200 characters when provided.`);
        }
        if (e.sourceUrl !== undefined) {
          if (typeof e.sourceUrl !== "string") {
            errors.push(`tokenPricing.${key}.sourceUrl must be a string when provided.`);
          } else {
            try {
              const parsed = new URL(e.sourceUrl);
              if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("unsupported protocol");
            } catch {
              errors.push(`tokenPricing.${key}.sourceUrl must be an absolute http or https URL when provided.`);
            }
          }
        }
        if (e.asOf !== undefined && (typeof e.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.asOf))) {
          errors.push(`tokenPricing.${key}.asOf must use YYYY-MM-DD when provided.`);
        }
      }
    }
  }

  return errors;
}

export function writeUserConfig(configPath: any, config: any) {
  const normalized = normalizeUserConfig(config);
  const errors = validateUserConfig(config);
  if (errors.length) {
    const error: any = new Error("Invalid AgentSession configuration.");
    error.validationErrors = errors;
    throw error;
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
}

export function applyRuntimeUserConfig(config: any, fileConfig: any) {
  config.resumeCommands = isObject(fileConfig.resumeCommands) ? fileConfig.resumeCommands : {};
  config.resumeShell = isObject(fileConfig.resumeShell) ? fileConfig.resumeShell : null;
  config.projectPaths = normalizeProjectPaths(fileConfig);
  config.tokenPricing = isObject(fileConfig.tokenPricing) ? fileConfig.tokenPricing : {};
  config.mcp = normalizeMcpConfig(fileConfig.mcp);
  return config;
}

function detectLang() {
  const env = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || "";
  return env.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function parseArgs(argv = process.argv.slice(2)) {
  const configuredMetaPath = process.env.AGENTSESSION_META_PATH
    ? path.resolve(process.env.AGENTSESSION_META_PATH)
    : path.join(defaultMetaDir(), "meta.db");
  const configuredMetaDir = path.dirname(configuredMetaPath);
  let configPath = process.env.AGENTSESSION_CONFIG || "";
  const explicitConfigIndex = argv.indexOf("--config");
  if (explicitConfigIndex >= 0 && argv[explicitConfigIndex + 1]) {
    configPath = argv[explicitConfigIndex + 1];
  }

  const resolvedConfigPath = configPath || path.join(configuredMetaDir, "config.json");
  const fileConfig = readUserConfig(resolvedConfigPath);
  const config = {
    ...defaults,
    ...fileConfig,
    metaDir: configuredMetaDir,
    lang: detectLang(),
    metaPath: "",
    configPath: resolvedConfigPath,
    allowTerminalLaunch: defaults.allowTerminalLaunch,
    resumeCommands: fileConfig.resumeCommands && typeof fileConfig.resumeCommands === "object"
      ? fileConfig.resumeCommands
      : {},
    resumeShell: fileConfig.resumeShell && typeof fileConfig.resumeShell === "object"
      ? fileConfig.resumeShell
      : null,
    projectPaths: fileConfig.projectPaths || {},
    mcp: normalizeMcpConfig(fileConfig.mcp)
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      config.port = Number(argv[++i]) || defaults.port;
    } else if (argv[i] === "--opencode-db" && argv[i + 1]) {
      config.dbPath = argv[++i];
    } else if (argv[i] === "--claude-dir" && argv[i + 1]) {
      config.claudeDir = argv[++i];
    } else if (argv[i] === "--codex-dir" && argv[i + 1]) {
      config.codexDir = argv[++i];
    } else if (argv[i] === "--pi-dir" && argv[i + 1]) {
      config.piDir = argv[++i];
    } else if (argv[i] === "--dsh-dir" && argv[i + 1]) {
      config.dshDir = argv[++i];
    } else if (argv[i] === "--openclaw-dir" && argv[i + 1]) {
      config.openclawDir = argv[++i];
    } else if (argv[i] === "--hermes-dir" && argv[i + 1]) {
      config.hermesDir = argv[++i];
    } else if (argv[i] === "--reindex") {
      config.reindex = true;
    } else if (argv[i] === "--disable-terminal-launch") {
      config.allowTerminalLaunch = false;
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config.configPath = argv[++i];
    } else if (argv[i] === "--lang" && argv[i + 1]) {
      config.lang = argv[++i] === "zh" ? "zh" : "en";
    } else if (argv[i] === "--open") {
      config.open = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`AgentSession — Multi-Provider Agent Runtime Inspector

Usage: agentsession [options]

Options:
  --port <number>       Server port (default: 3456, env: PORT)
  --opencode-db <path>  Path to opencode.db (env: AGENTSESSION_DB_PATH)
  --claude-dir <path>   Path to Claude CLI data dir (default: ~/.claude)
  --codex-dir <path>    Path to Codex data dir (default: ~/.codex)
  --pi-dir <path>       Path to Pi agent data dir (default: ~/.pi/agent)
  --dsh-dir <path>      Path to DeepSeek Harness data dir (default: $DSH_HOME or ~/.dsh)
  --openclaw-dir <path> Path to OpenClaw state dir (default: ~/.openclaw)
  --hermes-dir <path>   Path to Hermes Agent data dir
  --config <path>       Path to AgentSession JSON config
  --disable-terminal-launch
                        Disable resume command launching
  --reindex             Force full reindex of all providers on start
  --lang <en|zh>        UI language (default: auto-detect from LANG)
  --open                Open browser on start
  -h, --help            Show this help`);
      process.exit(0);
    }
  }

  // Env overrides (lower priority than CLI)
  if (!argv.includes("--port") && process.env.PORT) {
    config.port = Number(process.env.PORT) || defaults.port;
  }
  if (!argv.includes("--opencode-db") && process.env.AGENTSESSION_DB_PATH) {
    config.dbPath = process.env.AGENTSESSION_DB_PATH;
  }
  config.metaPath = configuredMetaPath;

  // Ensure meta directory exists
  mkdirSync(config.metaDir, { recursive: true });

  return config;
}

let _config: any;

export function getConfig() {
  if (!_config) _config = parseArgs();
  return _config;
}

export function initConfig(argv = process.argv.slice(2)) {
  _config = parseArgs(argv);
  return _config;
}
