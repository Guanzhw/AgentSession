import { en } from "./locales/en.js";
import { zh } from "./locales/zh.js";

const locales: Record<string, any> = { en, zh };
let currentLocale = "en";

export function setLocale(lang: any) {
  currentLocale = locales[lang] ? lang : "en";
}

export function getLocale() {
  return currentLocale;
}

export function t(key: any, params?: Record<string, string>) {
  let text = locales[currentLocale]?.[key] ?? locales.en[key] ?? key;
  // Interpolation is text-only; HTML renderers must still validate or escape
  // parameter values at the output boundary.
  if (params && typeof text === "string") {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, v);
    }
  }
  return text;
}
