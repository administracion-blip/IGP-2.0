import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type CompraLinea = Record<string, unknown>;

type ComprasProveedorCacheValue = {
  compras: CompraLinea[];
  loading: boolean;
  error: string | null;
  lastFetch: number | null;
  recargar: (opts?: { force?: boolean }) => Promise<void>;
};

const Ctx = createContext<ComprasProveedorCacheValue | null>(null);

const STALE_MS = 5 * 60 * 1000;

export function ComprasProveedorCacheProvider({ children }: { children: React.ReactNode }) {
  const [compras, setCompras] = useState<CompraLinea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  const fetchingRef = useRef(false);
  const comprasRef = useRef(compras);
  comprasRef.current = compras;
  const lastFetchRef = useRef(lastFetch);
  lastFetchRef.current = lastFetch;

  // recargar es referencialmente estable (deps []) — seguro en useEffect
  const recargar = useCallback(async (opts?: { force?: boolean }) => {
    if (fetchingRef.current) return;
    const force = opts?.force === true;
    if (
      !force &&
      lastFetchRef.current &&
      (Date.now() - lastFetchRef.current) < STALE_MS &&
      comprasRef.current.length > 0
    ) {
      return;
    }
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const url = force
        ? `${API_URL}/api/agora/purchases?refresh=1`
        : `${API_URL}/api/agora/purchases`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setCompras(data.items || []);
        setLastFetch(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  return (
    <Ctx.Provider value={{ compras, loading, error, lastFetch, recargar }}>
      {children}
    </Ctx.Provider>
  );
}

export function useComprasProveedorCache() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useComprasProveedorCache debe usarse dentro de ComprasProveedorCacheProvider');
  return ctx;
}
