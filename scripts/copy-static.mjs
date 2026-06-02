import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "src", "static");
const target = path.join(root, "dist", "src", "static");

if (existsSync(source)) {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
