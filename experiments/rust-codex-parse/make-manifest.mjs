import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--root' || args[2] !== '--output') {
  console.error('Usage: node make-manifest.mjs --root DIR --output FILE');
  process.exit(2);
}
const root = resolve(args[1]);
const output = resolve(args[3]);
const fromRoot = relative(root, output);
if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
  throw new Error('Manifest output must be outside the source directory');
}
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/i.test(entry.name)) files.push(file);
  }
}
visit(root);
files.sort();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(files));
console.log(JSON.stringify({ files: files.length }));
