/**
 * Small, source-aware cache for Token Explorer request slices. The source
 * fingerprint is supplied by the caller so provider data remains read-only.
 */
export function createStatsCache(maxEntries = 80, ttlMs = 5000) {
  const entries = new Map<string, { fingerprint: string; expiresAt: number; value: unknown }>();

  return {
    getOrBuild<T>(key: string, fingerprint: string, build: () => T): T {
      const now = Date.now();
      const cached = entries.get(key);
      if (cached && cached.fingerprint === fingerprint && cached.expiresAt > now) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.value as T;
      }

      const value = build();
      entries.set(key, { fingerprint, expiresAt: now + ttlMs, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return value;
    },
    clear() {
      entries.clear();
    }
  };
}
