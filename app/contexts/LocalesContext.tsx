import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { useAuth } from './AuthContext';

export type LocalItem = {
  id_Locales?: string;
  nombre?: string;
  Nombre?: string;
  agoraCode?: string;
  empresa?: string;
  id_empresa?: string;
  /** Brief de identidad visual (Marketing) */
  estilo_visual_brief?: string;
  /** Claves S3 de referencias visuales del estilo (máx. 3) */
  estilo_visual_imagen_keys?: string[];
  /** Sitio web público del local (referencia para prompts) */
  web?: string;
  km_desplazamiento?: number | string;
  [key: string]: unknown;
};

export function valorEnLocal(local: LocalItem, key: string): string | undefined {
  const v = local[key];
  if (v != null && v !== '') return String(v);
  const found = Object.keys(local).find((k) => k.toLowerCase() === key.toLowerCase());
  return found ? String(local[found] ?? '') : undefined;
}

export type LocalesValue = {
  locales: LocalItem[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/** Misma TTL que la caché de GET /locales en el servidor. */
const TTL_MS = 5 * 60 * 1000;

type LocalesContextValue = {
  valor: LocalesValue;
  /** Recarga en segundo plano si hubo error o los datos han caducado. */
  revalidar: () => void;
};

const LocalesContext = createContext<LocalesContextValue | null>(null);

/**
 * Caché compartida de GET /api/locales (listado completo, sin filtrar).
 * Se vacía al cerrar sesión o cambiar de usuario.
 */
export function LocalesProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id_usuario ?? null;
  const [locales, setLocales] = useState<LocalItem[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargadoEn, setCargadoEn] = useState<number | null>(null);

  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const cargadoEnRef = useRef<number | null>(null);
  const errorRef = useRef<string | null>(null);
  const enVueloRef = useRef<Promise<void> | null>(null);
  // Solo aplica su resultado la última petición lanzada (descarta refrescos superados y usuarios anteriores).
  const generacionRef = useRef(0);

  const cargar = useCallback((forzar: boolean): Promise<void> => {
    if (!userIdRef.current) return Promise.resolve();
    if (!forzar && enVueloRef.current) return enVueloRef.current;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    const promesa = (async () => {
      try {
        const res = await apiFetch('/api/locales');
        const data = (await res.json().catch(() => ({}))) as { locales?: LocalItem[]; error?: string };
        if (generacion !== generacionRef.current) return;
        if (!res.ok) throw new Error(data.error || 'Error al cargar locales');
        const ahora = Date.now();
        cargadoEnRef.current = ahora;
        errorRef.current = null;
        setLocales(Array.isArray(data.locales) ? data.locales : []);
        setCargadoEn(ahora);
        setError(null);
      } catch (e) {
        if (generacion !== generacionRef.current) return;
        const msg = e instanceof Error && e.message ? e.message : 'Error al cargar locales';
        errorRef.current = msg;
        setError(msg);
        if (cargadoEnRef.current == null) setLocales([]);
      } finally {
        if (generacion === generacionRef.current) {
          enVueloRef.current = null;
          setCargando(false);
        }
      }
    })();
    enVueloRef.current = promesa;
    return promesa;
  }, []);

  const ultimoUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (ultimoUserIdRef.current === userId) return;
    ultimoUserIdRef.current = userId;
    generacionRef.current += 1;
    enVueloRef.current = null;
    cargadoEnRef.current = null;
    errorRef.current = null;
    setLocales([]);
    setError(null);
    setCargadoEn(null);
    setCargando(false);
    if (userId) void cargar(false);
  }, [userId, cargar]);

  const refresh = useCallback(() => cargar(true), [cargar]);

  const revalidar = useCallback(() => {
    if (!userIdRef.current || enVueloRef.current) return;
    const caducado = cargadoEnRef.current != null && Date.now() - cargadoEnRef.current > TTL_MS;
    if (errorRef.current || caducado) void cargar(false);
  }, [cargar]);

  const valor = useMemo<LocalesValue>(
    () => ({
      locales,
      // Solo la primera carga cuenta como "cargando": los refrescos con datos no provocan parpadeo.
      loading: userId != null && cargadoEn == null && (cargando || error == null),
      error,
      refresh,
    }),
    [locales, cargando, cargadoEn, error, refresh, userId]
  );

  const value = useMemo<LocalesContextValue>(() => ({ valor, revalidar }), [valor, revalidar]);

  return <LocalesContext.Provider value={value}>{children}</LocalesContext.Provider>;
}

/** Al montar el consumidor reintenta si hubo error o recarga en segundo plano si los datos caducaron. */
export function useLocales(): LocalesValue {
  const ctx = useContext(LocalesContext);
  const revalidar = ctx?.revalidar;
  useEffect(() => {
    revalidar?.();
  }, [revalidar]);
  if (!ctx) throw new Error('useLocales debe usarse dentro de LocalesProvider');
  return ctx.valor;
}

function nombreLocal(l: LocalItem): string {
  return String(l.nombre ?? l.Nombre ?? '').trim();
}

/** Locales filtrados por `localPermitido` (criterio de Mantenimiento). */
export function useLocalesPermitidos(): LocalesValue {
  const base = useLocales();
  const { localPermitido } = useAuth();
  const locales = useMemo(
    () => base.locales.filter((l) => localPermitido(nombreLocal(l))),
    [base.locales, localPermitido]
  );
  return useMemo(() => ({ ...base, locales }), [base, locales]);
}

/** Con `marketing.gestionar` devuelve todos los locales; si no, filtra por `localPermitido`. */
export function useLocalesMarketing(): LocalesValue {
  const base = useLocales();
  const { localPermitido, hasPermiso } = useAuth();
  const esGestor = hasPermiso('marketing.gestionar');
  const locales = useMemo(
    () => (esGestor ? base.locales : base.locales.filter((l) => localPermitido(nombreLocal(l)))),
    [base.locales, esGestor, localPermitido]
  );
  return useMemo(() => ({ ...base, locales }), [base, locales]);
}
