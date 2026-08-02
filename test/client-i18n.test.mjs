// Test: Every ft() key used in client JS must exist in both locale tables.
// Reads source files directly (no build required).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = resolve(__dirname, "..", "src", "static");

async function extractLocaleKeys() {
  const i18nPath = join(staticDir, "app", "i18n.js");
  const { __I18N__ } = await import(pathToFileURL(i18nPath).href);
  const locales = Object.keys(__I18N__);
  const keysByLocale = {};
  for (const locale of locales) {
    keysByLocale[locale] = new Set(Object.keys(__I18N__[locale]));
  }
  return {
    locales,
    keysByLocale,
    allKeys: new Set(Object.keys(__I18N__[locales[0]] || {}))
  };
}

function extractFtKeys(filePath) {
  const src = readFileSync(filePath, "utf-8");
  const keys = new Set();
  const re = /\bft\(\s*(["'])((?:\\.|[^\\])*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    keys.add(m[2]);
  }
  return keys;
}

function collectJsFilesRecursive(dir) {
  const results = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...collectJsFilesRecursive(full));
      } else if (entry.endsWith(".js")) {
        results.push(full);
      }
    }
  } catch {
    // Directory may not exist
  }
  return results;
}

test("client i18n — every ft() key exists in both locale tables", async (t) => {
  const { locales, keysByLocale, allKeys } = await extractLocaleKeys();

  await t.test("locale tables contain expected locales", () => {
    assert.ok(locales.includes("en"), "en locale must exist");
    assert.ok(locales.includes("zh"), "zh locale must exist");
  });

  await t.test("both locale tables have the same key set", () => {
    const enKeys = keysByLocale["en"];
    const zhKeys = keysByLocale["zh"];
    const enOnly = [...enKeys].filter((k) => !zhKeys.has(k));
    const zhOnly = [...zhKeys].filter((k) => !enKeys.has(k));
    assert.deepStrictEqual(enOnly, [], "Keys in en but missing from zh");
    assert.deepStrictEqual(zhOnly, [], "Keys in zh but missing from en");
  });

  const clientFiles = collectJsFilesRecursive(staticDir);
  const usedKeys = new Set();
  for (const file of clientFiles) {
    for (const key of extractFtKeys(file)) {
      usedKeys.add(key);
    }
  }
  for (const state of ["prepared", "launched", "completed", "invalid", "failed", "unknown"]) {
    usedKeys.add(`analysis_status_${state}`);
  }

  await t.test("every used ft() key exists in locale tables", () => {
    const missing = [...usedKeys].filter((k) => !allKeys.has(k));
    if (missing.length > 0) {
      console.error("Missing i18n keys:", missing);
    }
    assert.deepStrictEqual(missing, [], `${missing.length} ft() key(s) missing from locale tables`);
  });

  console.log(`  Locale keys: ${allKeys.size} total in ${locales.join(", ")}`);
  console.log(`  Used keys in client JS: ${usedKeys.size}`);
});
