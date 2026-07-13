import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");

if (path.dirname(dist) !== root || path.basename(dist) !== "dist") {
  throw new Error(`Refusing to clean an unexpected build directory: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
