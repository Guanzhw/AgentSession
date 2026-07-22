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
    process.env.SESSION_VIEWER_DB_PATH || process.env.OPENCODE_DB_PATH,
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
  const legacyDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opensessionviewer")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opensessionviewer");
  const agentSessionDir = process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "agentsession")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentsession");
  if (existsSync(agentSessionDir)) return agentSessionDir;
  if (existsSync(legacyDir)) return legacyDir;
  return agentSessionDir;
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

function defaultGeminiDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".gemini");
  const candidates = [process.env.GEMINI_HOME, fallback];
  if (process.platform === "win32") {
    candidates.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "gemini"));
  }
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "gemini"));
  }
  return probePaths(candidates.filter(Boolean), fallback);
}

function defaultPiDir() {
  const home = os.homedir();
  const fallback = path.join(home, ".pi", "agent");
  return probePaths([process.env.PI_CODING_AGENT_DIR, fallback].filter(Boolean), fallback);
}

const defaults = {
  port: 3456,
  dbPath: defaultDbPath(),
  metaDir: defaultMetaDir(),
  lang: "en",
  open: false,
  claudeDir: defaultClaudeDir(),
  codexDir: defaultCodexDir(),
  geminiDir: defaultGeminiDir(),
  piDir: defaultPiDir(),
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

const LEGACY_ANALYSIS_MATERIALS = {
  skills: {
    roots: [
      ["skills", ".agents/skills", ".codex/skills"],
      [".opencode/skills", ".agents/skills", ".codex/skills"]
    ],
    files: [["AGENTS.md"]]
  },
  prompts: {
    roots: [["prompts", ".agents/prompts", ".codex/prompts"]]
  },
  agents: {
    roots: [[".agents/agents", ".codex/agents", ".claude/agents"]]
  },
  rules: {
    roots: [[".agents", ".codex", ".claude"]],
    files: [["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"]]
  }
};

function sameStringArray(left: any, right: any) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

const DEFAULT_ANALYSIS_OUTPUT_DIR = ".agentsession/analysis";
const LEGACY_DEFAULT_ANALYSIS_OUTPUT_DIR = ".opensessionviewer/analysis";

function migrateLegacyTargetMaterials(targetId: any, target: any) {
  if (!isObject(target)) return;
  const legacy = (LEGACY_ANALYSIS_MATERIALS as Record<string, any>)[targetId];
  if (!legacy) return;
  const legacyRootsMatched = legacy.roots?.some(
    (roots: any) => sameStringArray(target.artifactRoots, roots)
  );
  if (legacyRootsMatched) {
    delete target.artifactRoots;
  }
  if (
    legacyRootsMatched
    && legacy.files?.some((files: any) => sameStringArray(target.artifactFiles, files))
  ) {
    delete target.artifactFiles;
  }
}

function migrateLegacyAnalysisMaterials(config: any) {
  const analysis = isObject(config.analysis) ? config.analysis : null;
  if (!analysis) return config;
  const outputDir = typeof analysis.outputDir === "string"
    ? analysis.outputDir.replaceAll("\\", "/")
    : "";
  if (
    outputDir === LEGACY_DEFAULT_ANALYSIS_OUTPUT_DIR
    || outputDir === DEFAULT_ANALYSIS_OUTPUT_DIR
  ) {
    delete analysis.outputDir;
  }
  const targetGroups = [analysis.targets];
  if (isObject(analysis.providers)) {
    for (const provider of Object.values(analysis.providers)) {
      if (isObject(provider)) {
        const providerSettings: any = provider;
        targetGroups.push(providerSettings.targets);
      }
    }
  }
  for (const targets of targetGroups) {
    if (!isObject(targets)) continue;
    for (const [targetId, target] of Object.entries(targets)) {
      migrateLegacyTargetMaterials(targetId, target);
    }
  }
  return config;
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
      config: migrateLegacyAnalysisMaterials(parsed),
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

function validateAnalysisTargets(value: any, field: any, errors: any) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object.`);
    return;
  }
  for (const [targetId, target] of Object.entries(value)) {
    if (target === false) {
      continue;
    }
    if (!isObject(target)) {
      errors.push(`${field}.${targetId} must be an object or false.`);
      continue;
    }
    const targetSettings: any = target;
    for (const listField of ["artifactRoots", "artifactFiles", "fileExtensions", "extensions"]) {
      if (targetSettings[listField] !== undefined) {
        validateStringArray(targetSettings[listField], `${field}.${targetId}.${listField}`, errors);
      }
    }
    for (const textField of ["label", "prompt", "promptFile"]) {
      if (
        targetSettings[textField] !== undefined
        && typeof targetSettings[textField] !== "string"
      ) {
        errors.push(`${field}.${targetId}.${textField} must be a string.`);
      }
    }
    if (
      targetSettings.includeRawSnapshots !== undefined
      && typeof targetSettings.includeRawSnapshots !== "boolean"
    ) {
      errors.push(`${field}.${targetId}.includeRawSnapshots must be a boolean.`);
    }
    if (targetSettings.command !== undefined) {
      validateCommand(targetSettings.command, `${field}.${targetId}.command`, errors);
    }
    if (targetSettings.shell !== undefined) {
      validateShell(targetSettings.shell, `${field}.${targetId}.shell`, errors);
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

  if (config.analysis !== undefined) {
    if (!isObject(config.analysis)) {
      errors.push("analysis must be an object.");
    } else {
      if (config.analysis.enabled !== undefined && typeof config.analysis.enabled !== "boolean") {
        errors.push("analysis.enabled must be a boolean.");
      }
      if (config.analysis.defaultTarget !== undefined && typeof config.analysis.defaultTarget !== "string") {
        errors.push("analysis.defaultTarget must be a string.");
      }
      if (config.analysis.defaultTargets !== undefined) {
        validateStringArray(config.analysis.defaultTargets, "analysis.defaultTargets", errors);
        if (Array.isArray(config.analysis.defaultTargets) && config.analysis.defaultTargets.length === 0) {
          errors.push("analysis.defaultTargets must contain at least one target.");
        }
      }
      if (config.analysis.outputDir !== undefined && typeof config.analysis.outputDir !== "string") {
        errors.push("analysis.outputDir must be a string.");
      }
      if (config.analysis.includeRawSnapshots !== undefined && typeof config.analysis.includeRawSnapshots !== "boolean") {
        errors.push("analysis.includeRawSnapshots must be a boolean.");
      }
      if (config.analysis.shell !== undefined) {
        validateShell(config.analysis.shell, "analysis.shell", errors);
      }
      if (config.analysis.implementation !== undefined) {
        if (!isObject(config.analysis.implementation)) {
          errors.push("analysis.implementation must be an object.");
        } else {
          if (config.analysis.implementation.command !== undefined) {
            validateCommand(config.analysis.implementation.command, "analysis.implementation.command", errors);
          }
          if (config.analysis.implementation.shell !== undefined) {
            validateShell(config.analysis.implementation.shell, "analysis.implementation.shell", errors);
          }
        }
      }
      if (config.analysis.targets !== undefined) {
        validateAnalysisTargets(config.analysis.targets, "analysis.targets", errors);
      }
      if (config.analysis.providers !== undefined) {
        if (!isObject(config.analysis.providers)) {
          errors.push("analysis.providers must be an object.");
        } else {
          for (const [providerId, providerConfig] of Object.entries(config.analysis.providers)) {
            if (!isObject(providerConfig)) {
              errors.push(`analysis.providers.${providerId} must be an object.`);
              continue;
            }
            const providerSettings: any = providerConfig;
            if (
              providerSettings.defaultTarget !== undefined
              && typeof providerSettings.defaultTarget !== "string"
            ) {
              errors.push(`analysis.providers.${providerId}.defaultTarget must be a string.`);
            }
            if (providerSettings.defaultTargets !== undefined) {
              validateStringArray(
                providerSettings.defaultTargets,
                `analysis.providers.${providerId}.defaultTargets`,
                errors
              );
              if (
                Array.isArray(providerSettings.defaultTargets)
                && providerSettings.defaultTargets.length === 0
              ) {
                errors.push(
                  `analysis.providers.${providerId}.defaultTargets must contain at least one target.`
                );
              }
            }
            if (providerSettings.command !== undefined) {
              validateCommand(providerSettings.command, `analysis.providers.${providerId}.command`, errors);
            }
            if (providerSettings.projectPaths !== undefined) {
              validateProjectPathMap(
                providerSettings.projectPaths,
                `analysis.providers.${providerId}.projectPaths`,
                errors
              );
            }
            if (providerSettings.shell !== undefined) {
              validateShell(providerSettings.shell, `analysis.providers.${providerId}.shell`, errors);
            }
            if (providerSettings.implementation !== undefined) {
              if (!isObject(providerSettings.implementation)) {
                errors.push(`analysis.providers.${providerId}.implementation must be an object.`);
              } else {
                if (providerSettings.implementation.command !== undefined) {
                  validateCommand(
                    providerSettings.implementation.command,
                    `analysis.providers.${providerId}.implementation.command`,
                    errors
                  );
                }
                if (providerSettings.implementation.shell !== undefined) {
                  validateShell(
                    providerSettings.implementation.shell,
                    `analysis.providers.${providerId}.implementation.shell`,
                    errors
                  );
                }
              }
            }
            if (providerSettings.targets !== undefined) {
              validateAnalysisTargets(
                providerSettings.targets,
                `analysis.providers.${providerId}.targets`,
                errors
              );
            }
          }
        }
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
  const errors = validateUserConfig(config);
  if (errors.length) {
    const error: any = new Error("Invalid AgentSession configuration.");
    error.validationErrors = errors;
    throw error;
  }
  migrateLegacyAnalysisMaterials(config);
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function applyRuntimeUserConfig(config: any, fileConfig: any) {
  migrateLegacyAnalysisMaterials(fileConfig);
  config.resumeCommands = isObject(fileConfig.resumeCommands) ? fileConfig.resumeCommands : {};
  config.resumeShell = isObject(fileConfig.resumeShell) ? fileConfig.resumeShell : null;
  config.analysis = isObject(fileConfig.analysis) ? fileConfig.analysis : { enabled: false };
  config.tokenPricing = isObject(fileConfig.tokenPricing) ? fileConfig.tokenPricing : {};
  config.mcp = normalizeMcpConfig(fileConfig.mcp);
  return config;
}

function detectLang() {
  const env = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || "";
  return env.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function parseArgs(argv = process.argv.slice(2)) {
  let configPath = process.env.AGENTSESSION_CONFIG || process.env.OPENSESSIONVIEWER_CONFIG || "";
  const explicitConfigIndex = argv.indexOf("--config");
  if (explicitConfigIndex >= 0 && argv[explicitConfigIndex + 1]) {
    configPath = argv[explicitConfigIndex + 1];
  }

  const resolvedConfigPath = configPath || path.join(defaultMetaDir(), "config.json");
  const fileConfig = readUserConfig(resolvedConfigPath);
  const config = {
    ...defaults,
    ...fileConfig,
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
    analysis: fileConfig.analysis && typeof fileConfig.analysis === "object"
      ? fileConfig.analysis
      : { enabled: false },
    mcp: normalizeMcpConfig(fileConfig.mcp)
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      config.port = Number(argv[++i]) || defaults.port;
    } else if ((argv[i] === "--opencode-db" || argv[i] === "--db") && argv[i + 1]) {
      config.dbPath = argv[++i];
    } else if (argv[i] === "--claude-dir" && argv[i + 1]) {
      config.claudeDir = argv[++i];
    } else if (argv[i] === "--codex-dir" && argv[i + 1]) {
      config.codexDir = argv[++i];
    } else if (argv[i] === "--gemini-dir" && argv[i + 1]) {
      config.geminiDir = argv[++i];
    } else if (argv[i] === "--pi-dir" && argv[i + 1]) {
      config.piDir = argv[++i];
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
      console.log(`AgentSession — Multi-Provider Session Viewer & Manager

Usage: agentsession [options]

Options:
  --port <number>       Server port (default: 3456, env: PORT)
  --opencode-db <path>  Path to opencode.db (alias: --db, env: SESSION_VIEWER_DB_PATH)
  --claude-dir <path>   Path to Claude CLI data dir (default: ~/.claude)
  --codex-dir <path>    Path to Codex data dir (default: ~/.codex)
  --gemini-dir <path>   Path to Gemini data dir (default: ~/.gemini)
  --pi-dir <path>       Path to Pi agent data dir (default: ~/.pi/agent)
  --config <path>       Path to AgentSession JSON config
  --disable-terminal-launch
                        Disable resume and analysis command launching
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
  if (!argv.includes("--db") && !argv.includes("--opencode-db") && process.env.SESSION_VIEWER_DB_PATH) {
    config.dbPath = process.env.SESSION_VIEWER_DB_PATH;
  }
  if (process.env.AGENTSESSION_META_PATH || process.env.OPENSESSIONVIEWER_META_PATH || process.env.OH_MY_OPENSESSION_META_PATH) {
    config.metaDir = path.dirname(process.env.AGENTSESSION_META_PATH || process.env.OPENSESSIONVIEWER_META_PATH || process.env.OH_MY_OPENSESSION_META_PATH || "");
  }

  config.metaPath = path.join(config.metaDir, "meta.db");

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
