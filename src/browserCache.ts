interface BrowserCacheEntry<T> {
  storedAt: string;
  value: T;
}

const cachePrefix = "grounds-page-cache:";

export function readBrowserCache<T>(key: string) {
  try {
    const entry = JSON.parse(
      window.localStorage.getItem(`${cachePrefix}${key}`) ?? "null",
    ) as BrowserCacheEntry<T> | null;
    if (!entry?.storedAt || entry.value === undefined) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

export function writeBrowserCache<T>(key: string, value: T) {
  try {
    window.localStorage.setItem(
      `${cachePrefix}${key}`,
      JSON.stringify({ storedAt: new Date().toISOString(), value }),
    );
  } catch {
    // A cache write must never block fresh data from rendering.
  }
}
