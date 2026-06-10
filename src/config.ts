import os from "node:os";
import path from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

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

function readUserConfig(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.warn(`Ignoring invalid OpenSessionViewer config at ${configPath}: ${error.message}`);
    return {};
  }
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
      : null
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
                        Allow the local UI to open resume commands in a terminal
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
