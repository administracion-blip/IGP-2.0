import { apiFetch } from '../utils/api';

export type TopCamarerosPlanningRow = {
  rank: number;
  userId?: string;
  userName: string;
};

export type TopCamarerosPlanningData = {
  localId: string;
  dateFrom: string;
  dateTo: string;
  jornadaHoy?: string;
  sinDatos?: boolean;
  camareros: TopCamarerosPlanningRow[];
  lastSyncVentas?: string | null;
  fuente?: string;
  error?: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: TopCamarerosPlanningData; cachedAt: number }>();
const inflight = new Map<string, Promise<TopCamarerosPlanningData | null>>();

function cacheKey(localId: string): string {
  return String(localId).trim();
}

export function getTopCamarerosPlanningCached(localId: string): TopCamarerosPlanningData | null {
  const key = cacheKey(localId);
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.cachedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

export async function fetchTopCamarerosPlanning(
  localId: string,
  opts?: { force?: boolean },
): Promise<TopCamarerosPlanningData | null> {
  const key = cacheKey(localId);
  if (!key) return null;

  if (!opts?.force) {
    const hit = getTopCamarerosPlanningCached(key);
    if (hit) return hit;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const res = await apiFetch(
        `/api/planning-dia/top-camareros?localId=${encodeURIComponent(key)}`,
        { timeoutMs: 30_000 },
      );
      const data = (await res.json()) as TopCamarerosPlanningData;
      if (!res.ok || data.error) return null;
      cache.set(key, { data, cachedAt: Date.now() });
      return data;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Precarga en background el top de varios locales (p. ej. al cargar planning). */
export function prefetchTopCamarerosPlanning(localIds: string[]): void {
  for (const id of localIds) {
    const key = cacheKey(id);
    if (!key || getTopCamarerosPlanningCached(key)) continue;
    void fetchTopCamarerosPlanning(key);
  }
}
