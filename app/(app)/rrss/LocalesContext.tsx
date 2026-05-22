import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiFetch } from '../../utils/api';

export type LocalItem = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
  empresa?: string;
  /** Brief de identidad visual (Marketing); viene en GET /locales?minimal=1 con proyección ampliada */
  estilo_visual_brief?: string;
  /** Claves S3 de referencias visuales del estilo (máx. 3); opcional en listados */
  estilo_visual_imagen_keys?: string[];
  /** Sitio web público del local (referencia para prompts); opcional */
  web?: string;
};

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

const MarketingLocalesContext = createContext<LocalesContextValue | null>(null);

/**
 * Provider de locales para el módulo Marketing.
 *
 * A diferencia de `mantenimiento/LocalesContext`, este NO filtra por
 * `localPermitido` cuando el usuario tiene `marketing.gestionar` — los
 * gestores necesitan ver todos los locales (carteles-músico, config-estilo).
 * Para proponentes sin gestionar se sigue aplicando el filtro estándar.
 */
export function MarketingLocalesProvider({ children }: { children: React.ReactNode }) {
  const { localPermitido, hasPermiso } = useAuth();
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLocales = useCallback(() => {
    setLoading(true);
    setError(null);
    apiFetch('/api/locales?minimal=1')
      .then((res) => res.json())
      .then((data: { locales?: LocalItem[] }) => {
        const all = Array.isArray(data.locales) ? data.locales : [];
        const esGestor = hasPermiso('marketing.gestionar');
        setLocales(
          esGestor
            ? all
            : all.filter((l) => localPermitido(String(l.nombre ?? l.Nombre ?? '').trim()))
        );
      })
      .catch((e) => {
        setLocales([]);
        setError(e instanceof Error ? e.message : 'Error al cargar locales');
      })
      .finally(() => setLoading(false));
  }, [localPermitido, hasPermiso]);

  useEffect(() => {
    fetchLocales();
  }, [fetchLocales]);

  const value: LocalesContextValue = { locales, loading, error, refetch: fetchLocales };

  return <MarketingLocalesContext.Provider value={value}>{children}</MarketingLocalesContext.Provider>;
}

export function useMarketingLocales(): LocalesContextValue {
  const ctx = useContext(MarketingLocalesContext);
  if (!ctx) {
    throw new Error('useMarketingLocales debe usarse dentro de MarketingLocalesProvider');
  }
  return ctx;
}
