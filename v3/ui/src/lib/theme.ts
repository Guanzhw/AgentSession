export type ThemePreference = 'system' | 'light' | 'dark';

const themeStorageKey = 'agentsession-v3-theme';

export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(themeStorageKey);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  document.documentElement.dataset.theme = preference;
  window.localStorage.setItem(themeStorageKey, preference);
}
