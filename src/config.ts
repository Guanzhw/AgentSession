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
function probePaths(candidates, fallback) {
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
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opensessionviewer");
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "opensessionviewer");
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

const defaults = {
  port: 3456,
  dbPath: defaultDbPath(),
  metaDir: defaultMetaDir(),
  lang: "en",
  open: false,
  claudeDir: defaultClaudeDir(),
  codexDir: defaultCodexDir(),
  geminiDir: defaultGeminiDir(),
  reindex: false,
  allowTerminalLaunch: false,
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readUserConfigDocument(configPath) {
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
    return { exists: true, raw, config: parsed, error: "" };
  } catch (error) {
    return {
      exists: true,
      raw,
      config: {},
      error: error.message
    };
  }
}

export function readUserConfig(configPath) {
  const document = readUserConfigDocument(configPath);
  if (document.error) {
    console.warn(`Ignoring invalid OpenSessionViewer config at ${configPath}: ${document.error}`);
  }
  return document.config;
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings.`);
  }
}

function validateShell(value, field, errors) {
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

function validateCommand(value, field, errors) {
  if (!isObject(value)) {
    errors.push(`${field} must be an object.`);
    return;
  }
  if (typeof value.executable !== "string" || !value.executable.trim()) {
    errors.push(`${field}.executable must be a non-empty string.`);
  }
  if (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string")) {
    errors.push(`${field}.args must be an array of strings.`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    errors.push(`${field}.cwd must be a string.`);
  }
  if (value.stdin !== undefined && value.stdin !== "prompt") {
    errors.push(`${field}.stdin must be "prompt" when provided.`);
  }
}

export function validateUserConfig(config) {
  const errors = [];
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
      if (config.analysis.targets !== undefined) {
        if (!isObject(config.analysis.targets)) {
          errors.push("analysis.targets must be an object.");
        } else {
          for (const [targetId, target] of Object.entries(config.analysis.targets)) {
            if (!isObject(target)) {
              errors.push(`analysis.targets.${targetId} must be an object.`);
              continue;
            }
            for (const field of ["artifactRoots", "artifactFiles", "fileExtensions", "extensions"]) {
              if (target[field] !== undefined) {
                validateStringArray(target[field], `analysis.targets.${targetId}.${field}`, errors);
              }
            }
            for (const field of ["label", "prompt", "promptFile"]) {
              if (target[field] !== undefined && typeof target[field] !== "string") {
                errors.push(`analysis.targets.${targetId}.${field} must be a string.`);
              }
            }
          }
        }
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
            if (providerSettings.shell !== undefined) {
              validateShell(providerSettings.shell, `analysis.providers.${providerId}.shell`, errors);
            }
          }
        }
      }
    }
  }

  return errors;
}

export function writeUserConfig(configPath, config) {
  const errors = validateUserConfig(config);
  if (errors.length) {
    const error: any = new Error("Invalid OpenSessionViewer configuration.");
    error.validationErrors = errors;
    throw error;
  }
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function applyRuntimeUserConfig(config, fileConfig) {
  config.resumeCommands = isObject(fileConfig.resumeCommands) ? fileConfig.resumeCommands : {};
  config.resumeShell = isObject(fileConfig.resumeShell) ? fileConfig.resumeShell : null;
  config.analysis = isObject(fileConfig.analysis) ? fileConfig.analysis : { enabled: false };
  return config;
}

function detectLang() {
  const env = process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || "";
  return env.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function parseArgs(argv = process.argv.slice(2)) {
  let configPath = process.env.OPENSESSIONVIEWER_CONFIG || "";
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
    allowTerminalLaunch: false,
    resumeCommands: fileConfig.resumeCommands && typeof fileConfig.resumeCommands === "object"
      ? fileConfig.resumeCommands
      : {},
    resumeShell: fileConfig.resumeShell && typeof fileConfig.resumeShell === "object"
      ? fileConfig.resumeShell
      : null,
    analysis: fileConfig.analysis && typeof fileConfig.analysis === "object"
      ? fileConfig.analysis
      : { enabled: false }
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
    } else if (argv[i] === "--reindex") {
      config.reindex = true;
    } else if (argv[i] === "--allow-terminal-launch") {
      config.allowTerminalLaunch = true;
    } else if (argv[i] === "--config" && argv[i + 1]) {
      config.configPath = argv[++i];
    } else if (argv[i] === "--lang" && argv[i + 1]) {
      config.lang = argv[++i] === "zh" ? "zh" : "en";
    } else if (argv[i] === "--open") {
      config.open = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`OpenSessionViewer — Multi-Provider Session Viewer & Manager

Usage: opensessionviewer [options]

Options:
  --port <number>       Server port (default: 3456, env: PORT)
  --opencode-db <path>  Path to opencode.db (alias: --db, env: SESSION_VIEWER_DB_PATH)
  --claude-dir <path>   Path to Claude CLI data dir (default: ~/.claude)
  --codex-dir <path>    Path to Codex data dir (default: ~/.codex)
  --gemini-dir <path>   Path to Gemini data dir (default: ~/.gemini)
  --config <path>       Path to OpenSessionViewer JSON config
  --allow-terminal-launch
                        Allow the local UI to open resume and analysis commands
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
  if (process.env.OPENSESSIONVIEWER_META_PATH || process.env.OH_MY_OPENSESSION_META_PATH) {
    config.metaDir = path.dirname(process.env.OPENSESSIONVIEWER_META_PATH || process.env.OH_MY_OPENSESSION_META_PATH);
  }

  config.metaPath = path.join(config.metaDir, "meta.db");

  // Ensure meta directory exists
  mkdirSync(config.metaDir, { recursive: true });

  return config;
}

let _config;

export function getConfig() {
  if (!_config) _config = parseArgs();
  return _config;
}

export function initConfig(argv = process.argv.slice(2)) {
  _config = parseArgs(argv);
  return _config;
}
