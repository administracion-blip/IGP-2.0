/**
 * Historial paginado de una entidad del módulo de dirección.
 *
 * Sirve igual para `/api/proyectos/:id/actividad` y `/api/tareas/:id/actividad`:
 * las dos responden `{ actividad, cursor }` con el cursor opaco del contrato. Con
 * `ruta` a `null` no se pide nada (por ejemplo, mientras no se sabe el id).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import type { EntradaActividad } from '../types/tasks';

const LIMITE = 20;

export type ActividadPaginada = {
  entradas: EntradaActividad[];
  cargando: boolean;
  cargandoMas: boolean;
  error: string | null;
  hayMas: boolean;
  cargarMas: () => void;
  recargar: () => void;
};

export function useActividadTasks(ruta: string | null): ActividadPaginada {
  const [entradas, setEntradas] = useState<EntradaActividad[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pedir = useCallback(
    async (desde: string | null) => {
      if (!ruta) return;
      const esMas = desde != null;
      if (esMas) setCargandoMas(true);
      else setCargando(true);
      setError(null);
      try {
        const query = new URLSearchParams({ limite: String(LIMITE) });
        if (desde) query.set('cursor', desde);
        const res = await apiFetch(`${ruta}?${query.toString()}`);
        const data = (await res.json().catch(() => ({}))) as {
          actividad?: EntradaActividad[];
          cursor?: string | null;
          error?: string;
        };
        if (!res.ok) {
          setError(data.error || 'No se pudo cargar el historial');
          return;
        }
        const lote = Array.isArray(data.actividad) ? data.actividad : [];
        setEntradas((previas) => (esMas ? [...previas, ...lote] : lote));
        setCursor(data.cursor ?? null);
      } catch (e) {
        console.error('[tasks] fallo al leer el historial', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
      } finally {
        if (esMas) setCargandoMas(false);
        else setCargando(false);
      }
    },
    [ruta],
  );

  useEffect(() => {
    setEntradas([]);
    setCursor(null);
    if (ruta) void pedir(null);
  }, [ruta, pedir]);

  const cargarMas = useCallback(() => {
    if (!cursor || cargandoMas) return;
    void pedir(cursor);
  }, [cursor, cargandoMas, pedir]);

  const recargar = useCallback(() => {
    setCursor(null);
    void pedir(null);
  }, [pedir]);

  return { entradas, cargando, cargandoMas, error, hayMas: cursor != null, cargarMas, recargar };
}
