import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decisionRoot = join(repoRoot, ".agents", "decisions");
const lifecycleStates = new Set(["proposed", "implemented", "rejected"]);
const requiredDecisionSections = [
  "Context",
  "Decision",
  "Alternatives considered",
  "Consequences",
  "Verification"
];
const markdownRoots = [
  "AGENTS.md",
  "README.md",
  "README.en.md",
  "CHANGELOG.md",
  "Skills-evolve.md",
  "docs",
  "packages",
  ".agents",
  ".github"
];
const concreteProviderIds = new Set([
  "opencode",
  "claude-code",
  "codex",
  "openclaw",
  "hermes",
  "pi",
  "deepseek-harness"
]);

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const statless = readdirSync(root, { withFileTypes: true });
  const files = [];
  for (const entry of statless) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

function parseFrontMatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;
  const values = new Map();
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/i);
    if (field) values.set(field[1], field[2].trim());
  }
  return { body: normalized.slice(match[0].length), values };
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function decisionSections(body) {
  const withoutFences = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "");
  const headings = [...withoutFences.matchAll(/^##\s+(.+?)\s*$/gm)];
  return headings.map((heading, index) => ({
    name: heading[1],
    content: withoutFences
      .slice(heading.index + heading[0].length, headings[index + 1]?.index ?? withoutFences.length)
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim()
  }));
}

export function validateDecisionFile(filePath) {
  const errors = [];
  const state = basename(dirname(filePath));
  const name = basename(filePath);
  const text = readFileSync(filePath, "utf8");
  const frontMatter = parseFrontMatter(text);
  if (!lifecycleStates.has(state)) errors.push(`${name}: unknown lifecycle directory '${state}'`);
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) {
    errors.push(`${name}: use YYYY-MM-DD-short-kebab-title.md`);
  }
  if (!frontMatter) {
    errors.push(`${name}: missing closed YAML front matter`);
    return errors;
  }
  const status = frontMatter.values.get("status") ?? "";
  const date = frontMatter.values.get("date") ?? "";
  const decision = frontMatter.values.get("decision") ?? "";
  if (status !== state) errors.push(`${name}: status must be '${state}'`);
  if (!isCalendarDate(date)) errors.push(`${name}: date must be a real YYYY-MM-DD calendar date`);
  if (name.slice(0, 10) !== date) errors.push(`${name}: filename date must match front matter date`);
  if (!decision) errors.push(`${name}: decision is required`);

  const sections = decisionSections(frontMatter.body);
  const actualOrder = sections.map(({ name: sectionName }) => sectionName);
  let previousIndex = -1;
  for (const section of requiredDecisionSections) {
    const index = actualOrder.indexOf(section);
    if (index < 0) {
      errors.push(`${name}: missing '## ${section}'`);
      continue;
    }
    if (index <= previousIndex) errors.push(`${name}: '## ${section}' is out of order`);
    if (!sections[index].content) errors.push(`${name}: '## ${section}' must not be empty`);
    previousIndex = index;
  }
  return errors;
}

function collectMarkdown() {
  return markdownRoots.flatMap((entry) => {
    const path = join(repoRoot, entry);
    return extname(path).toLowerCase() === ".md" ? [path] : walkFiles(path).filter((file) => extname(file).toLowerCase() === ".md");
  });
}

function markdownLinkTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) targets.push(match[1]);
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) targets.push(match[1]);
  return targets;
}

export function verifyMarkdownLinks(files = collectMarkdown()) {
  const errors = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const rawTarget of markdownLinkTargets(text)) {
      const target = rawTarget.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0];
      if (!target || /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const resolved = resolve(dirname(file), target);
      if (!existsSync(resolved)) errors.push(`${relative(repoRoot, file)}: broken local link '${target}'`);
    }
  }
  return errors;
}

export function concreteProviderImports(text) {
  const imports = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) {
    const segments = match[1].split(/[\\/]/);
    if (segments.some((segment) => concreteProviderIds.has(segment))) imports.push(match[1]);
  }
  return imports;
}

export function concreteProviderIdLiterals(text) {
  const literals = [];
  for (const match of text.matchAll(/["'`]([^"'`]+)["'`]/g)) {
    if (concreteProviderIds.has(match[1])) literals.push(match[1]);
  }
  return literals;
}

export function verifyArchitectureBoundaries() {
  const errors = [];
  const sharedRoot = join(repoRoot, "src", "providers", "shared");
  for (const file of walkFiles(sharedRoot).filter((path) => /\.tsx?$/.test(path))) {
    const text = readFileSync(file, "utf8");
    const imports = concreteProviderImports(text);
    if (imports.length) {
      errors.push(`${relative(repoRoot, file)}: shared provider code imports concrete provider path '${imports[0]}'`);
    }
  }
  const runtime = join(repoRoot, "src", "protocol-runtime.ts");
  if (existsSync(runtime)) {
    const text = readFileSync(runtime, "utf8");
    const literals = concreteProviderIdLiterals(text);
    if (literals.length) {
      errors.push(`src/protocol-runtime.ts: runtime projections contain concrete provider ID '${literals[0]}'`);
    }
  }
  return errors;
}

export function runChecks() {
  const errors = [];
  for (const state of lifecycleStates) {
    const directory = join(decisionRoot, state);
    for (const file of walkFiles(directory).filter((path) => extname(path).toLowerCase() === ".md")) {
      if (basename(file).toLowerCase() === "readme.md") continue;
      errors.push(...validateDecisionFile(file));
    }
  }
  errors.push(...verifyMarkdownLinks(), ...verifyArchitectureBoundaries());
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const errors = runChecks();
  if (errors.length) {
    console.error(`Governance checks failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Governance checks passed: decisions, local Markdown targets, and architecture boundaries.");
  }
}
