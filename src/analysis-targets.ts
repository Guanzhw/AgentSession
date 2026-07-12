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

export const DEFAULT_ANALYSIS_TARGET = {
  label: "",
  artifactRoots: [],
  artifactFiles: [],
  fileExtensions: DEFAULT_ANALYSIS_EXTENSIONS,
  prompt: "",
  promptFile: ""
};

export const BUILTIN_ANALYSIS_TARGETS = {
  skills: {
    label: "Analyze skills",
    artifactRoots: [],
    fileExtensions: DEFAULT_ANALYSIS_EXTENSIONS,
    prompt: "Focus proposals on the selected provider runtime skills and their supporting files. Mark recurring harness or skill improvements as skill-evolution proposals when the session evidence shows they would improve future agent behavior."
  },
  prompts: {
    label: "Analyze prompts",
    artifactRoots: ["prompts"],
    fileExtensions: [".md", ".txt", ".json", ".yaml", ".yml"],
    prompt: "Focus proposals on reusable prompts, prompt templates, and prompt-specific guidance."
  },
  agents: {
    label: "Analyze agents",
    artifactRoots: [],
    fileExtensions: [".md", ".json", ".yaml", ".yml", ".toml"],
    prompt: "Focus proposals on selected provider runtime agent definitions, roles, tools, permissions, and handoff behavior."
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
    artifactRoots: [],
    artifactFiles: [],
    fileExtensions: [".md", ".json", ".yaml", ".yml", ".toml"],
    prompt: "Focus proposals on selected provider runtime instructions, policies, permissions, and operating rules."
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

export function getBuiltinAnalysisTarget(targetId: any) {
  return (BUILTIN_ANALYSIS_TARGETS as Record<string, any>)[targetId] || null;
}

export function mergeAnalysisTarget(base: any, override: any) {
  const left = base && typeof base === "object" ? base : {};
  const right = override && typeof override === "object" ? override : {};
  const defaultRoots = Array.isArray(left.artifactRoots)
    ? left.artifactRoots
    : DEFAULT_ANALYSIS_TARGET.artifactRoots;
  const defaultFiles = Array.isArray(left.artifactFiles)
    ? left.artifactFiles
    : DEFAULT_ANALYSIS_TARGET.artifactFiles;
  const defaultFileExtensions = Array.isArray(left.fileExtensions)
    ? left.fileExtensions
    : Array.isArray(left.extensions)
      ? left.extensions
      : DEFAULT_ANALYSIS_TARGET.fileExtensions;
  return {
    ...left,
    ...right,
    artifactRoots: Array.isArray(right.artifactRoots)
      ? right.artifactRoots
      : defaultRoots,
    artifactFiles: Array.isArray(right.artifactFiles)
      ? right.artifactFiles
      : defaultFiles,
    fileExtensions: Array.isArray(right.fileExtensions)
      ? right.fileExtensions
      : Array.isArray(right.extensions)
        ? right.extensions
        : defaultFileExtensions
  };
}

export function getSharedAnalysisTarget(analysisConfig: any, targetId: any) {
  const defaults = getBuiltinAnalysisTarget(targetId) || {
    ...DEFAULT_ANALYSIS_TARGET,
    label: `Analyze ${targetId}`
  };
  return mergeAnalysisTarget(defaults, analysisConfig?.targets?.[targetId]);
}

export function getProviderAnalysisTarget(analysisConfig: any, providerId: any, targetId: any) {
  return mergeAnalysisTarget(
    getSharedAnalysisTarget(analysisConfig, targetId),
    analysisConfig?.providers?.[providerId]?.targets?.[targetId]
  );
}
