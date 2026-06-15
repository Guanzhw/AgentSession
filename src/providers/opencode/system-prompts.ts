import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "../../db.js";
import { parseJson } from "./parser.js";

type Row = Record<string, any>;
type JsonObject = Record<string, any>;

export interface SystemPromptItem {
  kind: "agent" | "config" | "instruction" | "remote-instruction" | "session" | "project" | "workspace" | "permission" | "todo" | "first-user";
  title: string;
  preview: string;
  source: string;
  time: number;
}

export interface SystemPromptSection {
  title: string;
  note: string;
  items: SystemPromptItem[];
}

export interface SystemPromptsView {
  sessionId: string;
  mode: "opencode-resolved";
  hiddenPromptStored: false;
  note: string;
  selectedAgent: string;
  firstUserMessage: {
    id: string;
    time: number;
    preview: string;
  } | null;
  sections: SystemPromptSection[];
}

interface LoadedConfig {
  source: string;
  data: JsonObject;
}

interface AgentPrompt {
  name: string;
  prompt: string;
  source: string;
  description?: string;
  disabled?: boolean;
}

function asNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function compact(value: unknown, limit = 420) {
  if (value == null || value === "") {
    return "";
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function safeParse(value: unknown) {
  if (typeof value !== "string") {
    return value || null;
  }

  return parseJson(value);
}

function item(kind: SystemPromptItem["kind"], title: string, preview: unknown, source: string, time = 0): SystemPromptItem {
  return {
    kind,
    title,
    preview: compact(preview),
    source,
    time: asNumber(time)
  };
}

function firstTextPart(messageId: string, dbPath = undefined) {
  const db = getDb(dbPath);
  const row = db.prepare(`
    SELECT data
    FROM part
    WHERE message_id = ?
      AND json_extract(data, '$.type') = 'text'
    ORDER BY rowid ASC
    LIMIT 1
  `).get(messageId) as Row | undefined;
  const data = safeParse(row?.data) as Row | null;
  return typeof data?.text === "string" ? data.text : "";
}

function section(title: string, note: string, items: SystemPromptItem[]): SystemPromptSection {
  return { title, note, items: items.filter((entry) => entry.preview || entry.title) };
}

function existsFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function existsDir(dir: string) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readText(file: string) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function homeDir() {
  return process.env.USERPROFILE || os.homedir();
}

function opencodeConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(homeDir(), ".config", "opencode");
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => path.resolve(value))));
}

function ancestorDirs(start: string, stop?: string) {
  const result: string[] = [];
  let current = path.resolve(start || stop || process.cwd());
  const boundary = stop ? path.resolve(stop) : path.parse(current).root;

  while (true) {
    result.push(current);
    if (current === boundary || current === path.dirname(current)) {
      break;
    }
    if (stop && !current.toLowerCase().startsWith(boundary.toLowerCase())) {
      break;
    }
    current = path.dirname(current);
  }

  return result;
}

function stripJsonComments(input: string) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      output += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function parseJsonc(text: string) {
  try {
    return JSON.parse(stripJsonComments(text).replace(/,\s*([}\]])/g, "$1")) as JsonObject;
  } catch {
    return null;
  }
}

function loadConfigFile(file: string): LoadedConfig | null {
  if (!existsFile(file)) {
    return null;
  }

  const data = parseJsonc(readText(file));
  return data && typeof data === "object" ? { source: path.resolve(file), data } : null;
}

function configFiles(sessionDirectory: string, worktree: string) {
  const globalDir = opencodeConfigDir();
  const files: string[] = [
    path.join(globalDir, "config.json"),
    path.join(globalDir, "opencode.json"),
    path.join(globalDir, "opencode.jsonc")
  ];

  if (process.env.OPENCODE_CONFIG) {
    files.push(process.env.OPENCODE_CONFIG);
  }

  const direct = ancestorDirs(sessionDirectory, worktree)
    .flatMap((dir) => [path.join(dir, "opencode.jsonc"), path.join(dir, "opencode.json")])
    .reverse();
  files.push(...direct);

  for (const dir of configDirectories(sessionDirectory, worktree)) {
    if (dir.endsWith(".opencode") || dir === process.env.OPENCODE_CONFIG_DIR) {
      files.push(path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"));
    }
  }

  return unique(files);
}

function configDirectories(sessionDirectory: string, worktree: string) {
  const dirs = [
    opencodeConfigDir(),
    ...ancestorDirs(sessionDirectory, worktree).map((dir) => path.join(dir, ".opencode")),
    path.join(homeDir(), ".opencode"),
    ...(process.env.OPENCODE_CONFIG_DIR ? [process.env.OPENCODE_CONFIG_DIR] : [])
  ];
  return unique(dirs).filter(existsDir);
}

function mergePromptConfig(configs: LoadedConfig[]) {
  const agents: Record<string, AgentPrompt> = {};
  const instructions: string[] = [];
  let defaultAgent = "";

  for (const loaded of configs) {
    const data = loaded.data;
    if (typeof data.default_agent === "string") {
      defaultAgent = data.default_agent;
    }

    const configuredInstructions = Array.isArray(data.instructions) ? data.instructions : [];
    for (const entry of configuredInstructions) {
      if (typeof entry === "string" && !instructions.includes(entry)) {
        instructions.push(entry);
      }
    }

    const agentMap = {
      ...(data.agent && typeof data.agent === "object" ? data.agent : {}),
      ...(data.agents && typeof data.agents === "object" ? data.agents : {})
    };

    for (const [name, value] of Object.entries(agentMap)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const prompt = typeof (value as JsonObject).prompt === "string" ? (value as JsonObject).prompt : agents[name]?.prompt || "";
      agents[name] = {
        name,
        prompt,
        description: typeof (value as JsonObject).description === "string" ? (value as JsonObject).description : agents[name]?.description,
        disabled: Boolean((value as JsonObject).disable),
        source: loaded.source
      };
    }
  }

  return { agents, instructions, defaultAgent };
}

function parseMarkdownAgent(file: string, baseDir: string): AgentPrompt | null {
  const text = readText(file);
  if (!text.trim()) {
    return null;
  }

  let body = text;
  const data: JsonObject = {};
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) {
      const frontmatter = text.slice(3, end).trim();
      body = text.slice(end + 4).trim();
      for (const line of frontmatter.split(/\r?\n/)) {
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (match) {
          data[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
        }
      }
    }
  }

  const relative = path.relative(baseDir, file).replaceAll("\\", "/");
  const candidate = relative.replace(/^(agent|agents)\//, "");
  const ext = path.extname(candidate);
  const name = typeof data.name === "string" && data.name ? data.name : ext ? candidate.slice(0, -ext.length) : candidate;
  return {
    name,
    prompt: body.trim(),
    description: typeof data.description === "string" ? data.description : undefined,
    disabled: data.disable === "true",
    source: path.resolve(file)
  };
}

function findMarkdownAgents(dir: string) {
  const results: AgentPrompt[] = [];
  for (const folder of ["agent", "agents"]) {
    const root = path.join(dir, folder);
    if (!existsDir(root)) {
      continue;
    }
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(target);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const agent = parseMarkdownAgent(target, dir);
          if (agent) {
            results.push(agent);
          }
        }
      }
    }
  }
  return results;
}

function wildcardToRegExp(pattern: string) {
  const normalized = pattern.replaceAll("\\", "/");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const doubleStar = "__OPENSESSIONVIEWER_DOUBLE_STAR__";
  return new RegExp(`^${escaped.replaceAll("**", doubleStar).replaceAll("*", "[^/]*").replaceAll(doubleStar, ".*")}$`, "i");
}

function globFiles(baseDir: string, pattern: string) {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const hasWildcard = normalizedPattern.includes("*");
  if (!hasWildcard) {
    const exact = path.resolve(baseDir, pattern);
    return existsFile(exact) ? [exact] : [];
  }

  const regex = wildcardToRegExp(normalizedPattern);
  const results: string[] = [];
  const stack = [baseDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current || !existsDir(current)) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      const relative = path.relative(baseDir, target).replaceAll("\\", "/");
      if (regex.test(relative)) {
        results.push(target);
      }
    }
  }
  return results;
}

function configuredInstructionFiles(patterns: string[], sessionDirectory: string, worktree: string) {
  const localFiles: string[] = [];
  const remoteUrls: string[] = [];
  const searchDirs = ancestorDirs(sessionDirectory, worktree);

  for (const raw of patterns) {
    if (raw.startsWith("https://") || raw.startsWith("http://")) {
      remoteUrls.push(raw);
      continue;
    }

    const instruction = raw.startsWith("~/") ? path.join(homeDir(), raw.slice(2)) : raw;
    if (path.isAbsolute(instruction)) {
      const base = path.dirname(instruction);
      localFiles.push(...globFiles(base, path.basename(instruction)));
      continue;
    }

    for (const dir of searchDirs) {
      localFiles.push(...globFiles(dir, instruction));
    }
  }

  return { localFiles: unique(localFiles), remoteUrls: Array.from(new Set(remoteUrls)) };
}

function defaultSystemInstructionFiles(sessionDirectory: string, worktree: string) {
  const files: string[] = [];
  const globalAgents = path.join(opencodeConfigDir(), "AGENTS.md");
  const globalClaude = path.join(homeDir(), ".claude", "CLAUDE.md");
  if (existsFile(globalAgents)) {
    files.push(globalAgents);
  } else if (existsFile(globalClaude)) {
    files.push(globalClaude);
  }

  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
    const matches = ancestorDirs(sessionDirectory, worktree)
      .map((dir) => path.join(dir, name))
      .filter(existsFile);
    if (matches.length) {
      files.push(...matches);
      break;
    }
  }

  return unique(files);
}

export function resolveOpenCodeInstructionSources(sessionDirectory: string, worktree: string) {
  const configs = configFiles(sessionDirectory, worktree).map(loadConfigFile).filter((entry): entry is LoadedConfig => Boolean(entry));
  const merged = mergePromptConfig(configs);
  const configured = configuredInstructionFiles(merged.instructions, sessionDirectory, worktree);
  return {
    localFiles: unique([
      ...defaultSystemInstructionFiles(sessionDirectory, worktree),
      ...configured.localFiles
    ]),
    remoteUrls: configured.remoteUrls
  };
}

function resolveOpenCodePromptSources(session: Row | undefined, project: Row | undefined) {
  const sessionDirectory = String(session?.directory || project?.worktree || process.cwd());
  const worktree = String(project?.worktree || sessionDirectory);
  const configs = configFiles(sessionDirectory, worktree).map(loadConfigFile).filter((entry): entry is LoadedConfig => Boolean(entry));
  const merged = mergePromptConfig(configs);
  const directories = configDirectories(sessionDirectory, worktree);

  for (const dir of directories) {
    for (const agent of findMarkdownAgents(dir)) {
      merged.agents[agent.name] = agent;
    }
  }

  const selectedAgent = String(session?.agent || merged.defaultAgent || "build");
  const selectedPrompt = merged.agents[selectedAgent];
  const instructions = resolveOpenCodeInstructionSources(sessionDirectory, worktree);

  return {
    sessionDirectory,
    worktree,
    configs,
    selectedAgent,
    selectedPrompt,
    instructionPaths: instructions.localFiles,
    remoteInstructions: instructions.remoteUrls,
    allAgents: Object.values(merged.agents)
  };
}

export function buildOpenCodeSystemPrompts(sessionId: string, dbPath = undefined): SystemPromptsView {
  const db = getDb(dbPath);
  const session = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sessionId) as Row | undefined;
  const firstUser = db.prepare(`
    SELECT id, time_created, data
    FROM message
    WHERE session_id = ?
      AND json_extract(data, '$.role') = 'user'
    ORDER BY COALESCE(CAST(json_extract(data, '$.time.created') AS INTEGER), time_created), id
    LIMIT 1
  `).get(sessionId) as Row | undefined;
  const firstUserData = safeParse(firstUser?.data) as Row | null;
  const firstUserTime = asNumber(firstUserData?.time?.created) || asNumber(firstUser?.time_created);
  const firstUserPreview = firstUser?.id ? firstTextPart(firstUser.id, dbPath) : "";

  const project = session?.project_id
    ? db.prepare(`SELECT * FROM project WHERE id = ?`).get(session.project_id) as Row | undefined
    : undefined;
  const workspace = session?.workspace_id
    ? db.prepare(`SELECT * FROM workspace WHERE id = ?`).get(session.workspace_id) as Row | undefined
    : project?.id
      ? db.prepare(`SELECT * FROM workspace WHERE project_id = ? ORDER BY time_used DESC LIMIT 1`).get(project.id) as Row | undefined
      : undefined;
  const permission = project?.id
    ? db.prepare(`SELECT * FROM permission WHERE project_id = ?`).get(project.id) as Row | undefined
    : undefined;
  const todos = firstUserTime
    ? db.prepare(`
      SELECT content, status, priority, position, time_created
      FROM todo
      WHERE session_id = ?
        AND time_created <= ?
      ORDER BY position ASC
    `).all(sessionId, firstUserTime) as Row[]
    : [];
  const prompts = resolveOpenCodePromptSources(session, project);
  const selectedAgent = prompts.selectedPrompt;

  const sections = [
    section("Selected Agent Prompt", "OpenCode agents are user/config controlled. If the selected agent has a prompt in current config or agent markdown, it is shown here.", selectedAgent ? [
      item("agent", prompts.selectedAgent, selectedAgent.prompt || selectedAgent.description || "Agent exists but does not define an explicit prompt.", selectedAgent.source, session?.time_created)
    ] : [
      item("agent", prompts.selectedAgent, "No prompt for this selected agent was found in the currently resolvable OpenCode config files or agent markdown. It may have come from an older config, a plugin, or a built-in agent without an explicit prompt.", "opencode agent resolution", session?.time_created)
    ]),
    section("System Instruction Files", "OpenCode loads global/project AGENTS.md or CLAUDE.md plus configured instruction files before the first user message.", prompts.instructionPaths.map((file) => (
      item("instruction", path.basename(file), readText(file), file, fs.statSync(file).mtimeMs)
    ))),
    section("Configured Remote Instructions", "Remote instruction URLs are listed but not fetched by OpenSessionViewer.", prompts.remoteInstructions.map((url) => (
      item("remote-instruction", url, "Configured remote instruction URL.", url, session?.time_created)
    ))),
    section("Prompt Config Sources", "Current OpenCode config files and agent markdown files used to resolve prompt/instruction sources.", [
      ...prompts.configs.map((config) => item("config", path.basename(config.source), {
        default_agent: config.data.default_agent,
        instructions: config.data.instructions,
        agents: Object.keys(config.data.agent || config.data.agents || {})
      }, config.source, fs.statSync(config.source).mtimeMs)),
      ...prompts.allAgents.map((agent) => item("agent", agent.name, agent.disabled ? "disabled" : agent.description || agent.prompt, agent.source))
    ]),
    section("Stored Session Envelope", "DB metadata recorded with the session; useful evidence but not the prompt body by itself.", session ? [
      item("session", "Directory", session.directory, "session.directory", session.time_created),
      item("session", "Agent", session.agent, "session.agent", session.time_created),
      item("session", "Model", safeParse(session.model) || session.model, "session.model", session.time_created),
      item("session", "Permission mode", session.permission, "session.permission", session.time_created),
      item("session", "Version", session.version, "session.version", session.time_created)
    ] : []),
    section("Project And Workspace", "Project/workspace configuration stored locally before the first user message.", [
      ...(project ? [
        item("project", "Project name", project.name || project.id, "project.name", project.time_created),
        item("project", "Worktree", project.worktree, "project.worktree", project.time_created),
        item("project", "VCS", project.vcs, "project.vcs", project.time_created),
        item("project", "Sandboxes", safeParse(project.sandboxes) || project.sandboxes, "project.sandboxes", project.time_created),
        item("project", "Commands", safeParse(project.commands) || project.commands, "project.commands", project.time_created)
      ] : []),
      ...(workspace ? [
        item("workspace", "Workspace", {
          type: workspace.type,
          name: workspace.name,
          branch: workspace.branch,
          directory: workspace.directory,
          extra: safeParse(workspace.extra) || workspace.extra
        }, "workspace", workspace.time_used)
      ] : [])
    ]),
    section("Permission State", "Stored permission policy that can affect what the agent is allowed to do.", permission ? [
      item("permission", "Permission data", safeParse(permission.data) || permission.data, "permission.data", permission.time_created)
    ] : []),
    section("Pre-User Todos", "Todos are listed only if their timestamp proves they existed before the first user message.", todos.map((todo) => item("todo", todo.content || `todo ${todo.position}`, {
      status: todo.status,
      priority: todo.priority
    }, "todo", todo.time_created))),
    section("First User Boundary", "Everything above is resolved before this first user message. The user text itself is shown only as the boundary.", firstUser ? [
      item("first-user", firstUser.id, firstUserPreview, "message.first-user", firstUserTime)
    ] : [])
  ];

  return {
    sessionId,
    mode: "opencode-resolved",
    hiddenPromptStored: false,
    selectedAgent: prompts.selectedAgent,
    note: "OpenCode system prompts are primarily controlled by user/project config: agent prompts, AGENTS.md/CLAUDE.md, and configured instruction files. This view resolves the currently available local sources for the session directory; plugin-provided or historical prompt text may not be recoverable from the DB.",
    firstUserMessage: firstUser ? {
      id: firstUser.id,
      time: firstUserTime,
      preview: compact(firstUserPreview)
    } : null,
    sections
  };
}
