import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const source = path.resolve("dist");
const destination = path.resolve("packages", "agentsession", "dist");

if (!existsSync(source)) {
  throw new Error(`Core build output does not exist: ${source}`);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
