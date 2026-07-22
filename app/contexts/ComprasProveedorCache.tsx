import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import type { CompraLinea } from '../types/compras';
import {
  buildPurchasesQuery,
  DIAS_CARGA_COMPRAS,
  rangoComprasDefault,
} from '../lib/comprasProveedorRango';

export type ComprasProveedorRango = {
  dateFrom: string | null;
  dateTo: string | null;
  all: boolean;
};

export type RecargarComprasOpts = {
  force?: boolean;
  dateFrom?: string;
  dateTo?: string;
  all?: boolean;
};

type ComprasProveedorCacheValue = {
  compras: CompraLinea[];
  loading: boolean;
  error: string | null;
  lastFetch: number | null;
  rangoCargado: ComprasProveedorRango | null;
  recargar: (opts?: RecargarComprasOpts) => Promise<void>;
};

const Ctx = createContext<ComprasProveedorCacheValue | null>(null);

const STALE_MS = 5 * 60 * 1000;

function rangoKey(r: ComprasProveedorRango): string {
  if (r.all) return 'all';
  return `${r.dateFrom || ''}|${r.dateTo || ''}`;
}

function resolveRango(opts?: RecargarComprasOpts, prev?: ComprasProveedorRango | null): ComprasProveedorRango {
  if (opts?.all) return { dateFrom: null, dateTo: null, all: true };
  if (opts?.dateFrom || opts?.dateTo) {
    return {
      dateFrom: opts.dateFrom ?? null,
      dateTo: opts.dateTo ?? null,
      all: false,
    };
  }
  if (prev) return prev;
  const def = rangoComprasDefault(DIAS_CARGA_COMPRAS);
  return { dateFrom: def.dateFrom, dateTo: def.dateTo, all: false };
}

export function ComprasProveedorCacheProvider({ children }: { children: React.ReactNode }) {
  const [compras, setCompras] = useState<CompraLinea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [rangoCargado, setRangoCargado] = useState<ComprasProveedorRango | null>(null);

  const fetchingRef = useRef(false);
  const comprasRef = useRef(compras);
  comprasRef.current = compras;
  const lastFetchRef = useRef(lastFetch);
  lastFetchRef.current = lastFetch;
  const rangoRef = useRef(rangoCargado);
  rangoRef.current = rangoCargado;

  const recargar = useCallback(async (opts?: RecargarComprasOpts) => {
    if (fetchingRef.current) return;
    const force = opts?.force === true;
    const rango = resolveRango(opts, rangoRef.current);
    const mismoRango = rangoRef.current && rangoKey(rangoRef.current) === rangoKey(rango);

    if (
      !force &&
      mismoRango &&
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
      const path = buildPurchasesQuery({
        refresh: force,
        all: rango.all,
        dateFrom: rango.dateFrom ?? undefined,
        dateTo: rango.dateTo ?? undefined,
      });
      const res = await apiFetch(path, {
        // Scan de DynamoDB + JSON; puede superar el timeout por defecto (30 s).
        timeoutMs: 0,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error || `HTTP ${res.status}`);
      } else {
        setCompras(data.items || []);
        setLastFetch(Date.now());
        setRangoCargado(rango);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Error de conexión';
      setError(
        /abort/i.test(raw)
          ? 'La carga de compras se interrumpió (tiempo de espera agotado). Comprueba que la API responde e inténtalo de nuevo.'
          : raw,
      );
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  return (
    <Ctx.Provider value={{ compras, loading, error, lastFetch, rangoCargado, recargar }}>
      {children}
    </Ctx.Provider>
  );
}

export function useComprasProveedorCache() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useComprasProveedorCache debe usarse dentro de ComprasProveedorCacheProvider');
  return ctx;
}
