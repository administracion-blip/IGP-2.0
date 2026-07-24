import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';

type Producto = Record<string, unknown>;

type SyncResultado = { added?: number; updated?: number; unchanged?: number };

/** Mensaje de error legible según el tipo de fallo (timeout, red, o error propagado). */
function mensajeErrorSync(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e && (e as { name?: string }).name === 'AbortError') {
    return 'La sincronización tardó demasiado en responder. Puede seguir en segundo plano; pulsa Recargar en unos segundos.';
  }
  if (e instanceof TypeError) {
    return 'Error de red: no se pudo contactar con el servidor.';
  }
  return e instanceof Error ? e.message : 'Error al sincronizar';
}

type ProductosCacheValue = {
  productos: Producto[];
  productosIgp: Producto[];
  loading: boolean;
  syncing: boolean;
  error: string | null;
  lastFetch: number | null;
  recargar: () => Promise<void>;
  sincronizar: () => Promise<{ added?: number; updated?: number; unchanged?: number } | null>;
  updateProductoLocal: (id: string, patch: Record<string, unknown>) => void;
};

const ProductosCacheContext = createContext<ProductosCacheValue | null>(null);

export function ProductosCacheProvider({ children }: { children: React.ReactNode }) {
  const [productos, setProductos] = useState<Producto[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const fetchingRef = useRef(false);

  const sortById = (list: Producto[]) =>
    [...list].sort((a, b) => {
      const idA = a.Id ?? a.id ?? a.Code ?? a.code ?? 0;
      const idB = b.Id ?? b.id ?? b.Code ?? b.code ?? 0;
      const na = typeof idA === 'number' ? idA : parseInt(String(idA).replace(/^0+/, ''), 10) || 0;
      const nb = typeof idB === 'number' ? idB : parseInt(String(idB).replace(/^0+/, ''), 10) || 0;
      return na - nb;
    });

  const recargar = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/agora/products');
      const data: { productos?: Producto[]; error?: string } = await res.json();
      if (data.error) {
        setError(data.error);
        setProductos([]);
      } else {
        const list = Array.isArray(data.productos) ? data.productos : [];
        setProductos(sortById(list));
        setLastFetch(Date.now());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de conexión');
      setProductos([]);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  /** Consulta el estado del job de sync hasta que termine (done) o falle (error). */
  const esperarSyncProductos = useCallback(async (): Promise<SyncResultado | null> => {
    const MAX_MS = 5 * 60 * 1000; // tope de espera del cliente
    const INTERVALO_MS = 2500;
    const inicio = Date.now();
    while (Date.now() - inicio < MAX_MS) {
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
      const res = await apiFetch('/api/agora/products/sync/status', { timeoutMs: 15000 });
      const st = await res.json().catch(() => ({} as Record<string, unknown>));
      if (st.status === 'done') {
        return { added: st.added, updated: st.updated, unchanged: st.unchanged };
      }
      if (st.status === 'error') {
        setError(typeof st.error === 'string' && st.error ? st.error : 'Error al sincronizar productos');
        return null;
      }
      // 'running' | 'idle' → seguir esperando
    }
    setError('La sincronización está tardando más de lo previsto. Sigue en segundo plano; pulsa Recargar en unos minutos.');
    return null;
  }, []);

  const sincronizar = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      // Lanza el job en segundo plano (respuesta inmediata); luego hacemos polling.
      const res = await apiFetch('/api/agora/products/sync?force=1&async=1', {
        method: 'POST',
        body: '{}',
        timeoutMs: 20000,
      });
      if (res.status === 403) {
        setError('No tienes permiso para sincronizar productos.');
        return null;
      }
      if (res.status === 429) {
        setError('Demasiadas sincronizaciones seguidas. Espera un momento e inténtalo de nuevo.');
        return null;
      }
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || data.error) {
        setError(typeof data.error === 'string' && data.error ? data.error : 'Error al sincronizar');
        return null;
      }
      // Sincronización reciente (throttle): nada que recargar.
      if (data.status === 'skipped') {
        setLastFetch(Date.now());
        return { added: 0, updated: 0, unchanged: 0 };
      }

      const result = await esperarSyncProductos();
      if (!result) return null;

      if ((result.added ?? 0) > 0 || (result.updated ?? 0) > 0) {
        await recargar();
      } else {
        setLastFetch(Date.now());
      }
      return result;
    } catch (e) {
      setError(mensajeErrorSync(e));
      return null;
    } finally {
      setSyncing(false);
    }
  }, [recargar, esperarSyncProductos]);

  const updateProductoLocal = useCallback((id: string, patch: Record<string, unknown>) => {
    setProductos((prev) =>
      prev.map((p) => {
        const pid = String(p.Id ?? p.id ?? p.Code ?? '');
        return pid === id ? { ...p, ...patch } : p;
      })
    );
  }, []);

  const productosIgp = React.useMemo(
    () => productos.filter((p) => p.IGP === true || p.IGP === 'true'),
    [productos]
  );

  return (
    <ProductosCacheContext.Provider
      value={{ productos, productosIgp, loading, syncing, error, lastFetch, recargar, sincronizar, updateProductoLocal }}
    >
      {children}
    </ProductosCacheContext.Provider>
  );
}

export function useProductosCache() {
  const ctx = useContext(ProductosCacheContext);
  if (!ctx) throw new Error('useProductosCache debe usarse dentro de ProductosCacheProvider');
  return ctx;
}
