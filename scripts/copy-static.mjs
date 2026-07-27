import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "src", "static");
const target = path.join(root, "dist", "src", "static");
const sourceModules = path.join(source, "app");

if (existsSync(source)) {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (entry) => entry !== sourceModules
  });
  await build({
    entryPoints: [path.join(source, "app.js")],
    outfile: path.join(target, "app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    sourcemap: false,
    minify: false,
    legalComments: "none"
  });
}
