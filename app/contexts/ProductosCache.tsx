import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

type Producto = Record<string, unknown>;

type ProductosCacheValue = {
  productos: Producto[];
  productosIgp: Producto[];
  loading: boolean;
  syncing: boolean;
  error: string | null;
  lastFetch: number | null;
  recargar: () => Promise<void>;
  sincronizar: () => Promise<{ added?: number; updated?: number; unchanged?: number } | null>;
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
      const res = await fetch(`${API_URL}/api/agora/products`);
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

  const sincronizar = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/agora/products/sync?force=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        return null;
      }
      if (data.ok && ((data.added ?? 0) > 0 || (data.updated ?? 0) > 0)) {
        await recargar();
      } else if (data.ok) {
        setLastFetch(Date.now());
      }
      return { added: data.added, updated: data.updated, unchanged: data.unchanged };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al sincronizar');
      return null;
    } finally {
      setSyncing(false);
    }
  }, [recargar]);

  const productosIgp = React.useMemo(
    () => productos.filter((p) => p.IGP === true || p.IGP === 'true'),
    [productos]
  );

  return (
    <ProductosCacheContext.Provider
      value={{ productos, productosIgp, loading, syncing, error, lastFetch, recargar, sincronizar }}
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
