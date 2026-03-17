import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3002';

export type LocalItem = { id_Locales?: string; nombre?: string; Nombre?: string };

export function valorEnLocal(local: LocalItem, key: string): string | undefined {
  const v = (local as Record<string, unknown>)[key];
  if (v != null && v !== '') return String(v);
  const found = Object.keys(local).find((k) => k.toLowerCase() === key.toLowerCase());
  return found ? String((local as Record<string, unknown>)[found] ?? '') : undefined;
}

type LocalesContextValue = {
  locales: LocalItem[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

const LocalesContext = createContext<LocalesContextValue | null>(null);

export function MantenimientoLocalesProvider({ children }: { children: React.ReactNode }) {
  const { localPermitido } = useAuth();
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLocales = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_URL}/api/locales?minimal=1`)
      .then((res) => res.json())
      .then((data: { locales?: LocalItem[] }) => {
        const all = Array.isArray(data.locales) ? data.locales : [];
        setLocales(all.filter((l) => localPermitido(String(l.nombre ?? l.Nombre ?? '').trim())));
      })
      .catch((e) => {
        setLocales([]);
        setError(e.message ?? 'Error al cargar locales');
      })
      .finally(() => setLoading(false));
  }, [localPermitido]);

  useEffect(() => {
    fetchLocales();
  }, [fetchLocales]);

  const value: LocalesContextValue = { locales, loading, error, refetch: fetchLocales };

  return <LocalesContext.Provider value={value}>{children}</LocalesContext.Provider>;
}

export function useMantenimientoLocales(): LocalesContextValue {
  const ctx = useContext(LocalesContext);
  if (!ctx) {
    throw new Error('useMantenimientoLocales debe usarse dentro de MantenimientoLocalesProvider');
  }
  return ctx;
}
