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

export function t(key: any) {
  return locales[currentLocale]?.[key] ?? locales.en[key] ?? key;
}
