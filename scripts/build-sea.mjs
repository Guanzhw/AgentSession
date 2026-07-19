import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 25 || (nodeMajor === 25 && nodeMinor < 5)) {
  throw new Error(`Node.js 25.5 or newer is required to build SEA binaries; found ${process.version}`);
}
const requestedOutDir = process.argv[2] || path.join(root, "artifacts", "binaries");
const outDir = path.resolve(requestedOutDir);
mkdirSync(outDir, { recursive: true });

const workDir = path.join(root, "tmp", "sea-build", `${process.platform}-${process.arch}`);
mkdirSync(workDir, { recursive: true });

const bundle = async (entryPoint, outfile) => {
  await build({
    entryPoints: [path.join(root, entryPoint)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    sourcemap: false,
    minify: false,
    legalComments: "none"
  });
};

const viewerEntry = path.join(workDir, "agentsession.mjs");
const mcpEntry = path.join(workDir, "agentsession-mcp.mjs");
const analysisToolAsset = path.join(workDir, "analysis-tools.js");
const analysisLayoutAsset = path.join(workDir, "analysis-layout.js");

await Promise.all([
  bundle("bin/binary.ts", viewerEntry),
  bundle("packages/agentsession-mcp/src/cli.ts", mcpEntry),
  bundle("src/analysis-tools.ts", analysisToolAsset),
  bundle("src/analysis-layout.ts", analysisLayoutAsset)
]);

const extension = process.platform === "win32" ? ".exe" : "";
const targets = [
  {
    name: "agentsession",
    main: viewerEntry,
    output: path.join(outDir, `agentsession${extension}`),
    assets: {
      "static/app.js": path.join(root, "src", "static", "app.js"),
      "static/style.css": path.join(root, "src", "static", "style.css"),
      "analysis-tools.js": analysisToolAsset,
      "analysis-layout.js": analysisLayoutAsset
    }
  },
  {
    name: "agentsession-mcp",
    main: mcpEntry,
    output: path.join(outDir, `agentsession-mcp${extension}`),
    assets: {}
  }
];

for (const target of targets) {
  rmSync(target.output, { force: true });
  const configPath = path.join(workDir, `${target.name}.sea.json`);
  writeFileSync(configPath, JSON.stringify({
    main: target.main,
    mainFormat: "module",
    output: target.output,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: target.assets
  }, null, 2));
  const result = spawnSync(process.execPath, [`--build-sea=${configPath}`], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`Failed to build ${target.name} SEA (exit ${result.status})`);
  }
}

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
writeFileSync(path.join(outDir, "binary-metadata.json"), JSON.stringify({
  version,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  files: targets.map((target) => path.basename(target.output))
}, null, 2));

console.log(`Built AgentSession ${version} binaries in ${outDir}`);
