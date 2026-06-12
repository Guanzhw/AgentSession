export const DEFAULT_ANALYSIS_EXTENSIONS = [
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".ps1"
];

export const BUILTIN_ANALYSIS_TARGETS = {
  skills: {
    label: "Analyze skills",
    artifactRoots: ["skills", ".agents/skills", ".codex/skills"],
    fileExtensions: DEFAULT_ANALYSIS_EXTENSIONS,
    prompt: "Focus proposals on reusable agent skills and their supporting files."
  },
  prompts: {
    label: "Analyze prompts",
    artifactRoots: ["prompts", ".agents/prompts", ".codex/prompts"],
    fileExtensions: [".md", ".txt", ".json", ".yaml", ".yml"],
    prompt: "Focus proposals on reusable prompts, prompt templates, and prompt-specific guidance."
  },
  agents: {
    label: "Analyze agents",
    artifactRoots: [".agents/agents", ".codex/agents", ".claude/agents"],
    fileExtensions: [".md", ".json", ".yaml", ".yml", ".toml"],
    prompt: "Focus proposals on agent definitions, roles, tools, permissions, and handoff behavior."
  },
  docs: {
    label: "Analyze docs",
    artifactRoots: ["docs", "doc", "documentation"],
    artifactFiles: ["README.md", "README.mdx", "CONTRIBUTING.md", "CHANGELOG.md"],
    fileExtensions: [".md", ".mdx", ".txt", ".rst", ".adoc"],
    prompt: "Focus proposals on durable user and developer documentation supported by the session evidence."
  },
  rules: {
    label: "Analyze rules",
    artifactRoots: [".agents", ".codex", ".claude"],
    artifactFiles: ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"],
    fileExtensions: [".md", ".json", ".yaml", ".yml", ".toml"],
    prompt: "Focus proposals on project and agent instruction files, policies, permissions, and operating rules."
  },
  tests: {
    label: "Analyze tests",
    artifactRoots: ["test", "tests", "__tests__", "spec"],
    fileExtensions: [
      ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go",
      ".java", ".kt", ".cs", ".rb", ".php", ".sh", ".ps1", ".json", ".yaml", ".yml"
    ],
    prompt: "Focus proposals on executable tests, fixtures, assertions, and regression coverage."
  },
  workflows: {
    label: "Analyze workflows",
    artifactRoots: [".github/workflows", ".gitlab/ci", ".azure/pipelines"],
    fileExtensions: [".yaml", ".yml", ".json", ".toml", ".sh", ".ps1"],
    prompt: "Focus proposals on CI, automation, release, and repository workflow definitions."
  },
  scripts: {
    label: "Analyze scripts",
    artifactRoots: ["scripts", "bin", "tools"],
    fileExtensions: [
      ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".php", ".sh", ".bash",
      ".zsh", ".fish", ".ps1", ".cmd", ".bat"
    ],
    prompt: "Focus proposals on repeatable project scripts, command-line helpers, and operational tooling."
  }
};

export function getBuiltinAnalysisTarget(targetId) {
  return BUILTIN_ANALYSIS_TARGETS[targetId] || null;
}
