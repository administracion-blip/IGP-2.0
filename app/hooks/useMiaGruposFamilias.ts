/**
 * Agrupaciones de familias Ágora para MIA (persistidas en servidor).
 * No usa AsyncStorage: todo vía apiFetch.
 */
import { useCallback, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';

export type MiaFamilia = {
  id: string;
  nombre: string;
};

export type MiaGrupoFamilias = {
  id: string;
  nombre: string;
  familiaIds: string[];
  orden: number;
  activo: boolean;
};

function mapGrupo(raw: Record<string, unknown>): MiaGrupoFamilias | null {
  const id = String(raw?.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    nombre: String(raw?.nombre ?? '').trim() || id,
    familiaIds: Array.isArray(raw?.familiaIds)
      ? raw.familiaIds.map((x) => String(x).trim()).filter(Boolean)
      : [],
    orden: typeof raw?.orden === 'number' && Number.isFinite(raw.orden) ? raw.orden : 0,
    activo: raw?.activo !== false,
  };
}

export function useMiaGruposFamilias() {
  const [grupos, setGrupos] = useState<MiaGrupoFamilias[]>([]);
  const [familias, setFamilias] = useState<MiaFamilia[]>([]);
  const [loadingGrupos, setLoadingGrupos] = useState(false);
  const [loadingFamilias, setLoadingFamilias] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargarGrupos = useCallback(async (opts?: { todos?: boolean }) => {
    setLoadingGrupos(true);
    setError(null);
    try {
      const qs = opts?.todos ? '?todos=1' : '';
      const r = await apiFetch(`/api/mia/grupos-familias${qs}`);
      const data = await r.json();
      if (!r.ok || data.error) {
        setError(data.error || 'No se pudieron cargar las agrupaciones');
        setGrupos([]);
        return [];
      }
      const list = (Array.isArray(data.grupos) ? data.grupos : [])
        .map((g: Record<string, unknown>) => mapGrupo(g))
        .filter(Boolean) as MiaGrupoFamilias[];
      list.sort(
        (a, b) =>
          a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }),
      );
      setGrupos(list);
      return list;
    } catch (e) {
      setError(errorMessage(e, 'Error cargando agrupaciones'));
      setGrupos([]);
      return [];
    } finally {
      setLoadingGrupos(false);
    }
  }, []);

  const cargarFamilias = useCallback(async () => {
    setLoadingFamilias(true);
    try {
      const r = await apiFetch('/api/mia/familias');
      const data = await r.json();
      if (!r.ok || data.error) {
        setError((prev) => prev || data.error || 'No se pudieron cargar las familias');
        setFamilias([]);
        return [];
      }
      const list: MiaFamilia[] = (Array.isArray(data.familias) ? data.familias : []).map(
        (f: { id?: string | number; nombre?: string }) => ({
          id: String(f.id ?? '').trim(),
          nombre: String(f.nombre || f.id || '').trim(),
        }),
      ).filter((f: MiaFamilia) => f.id);
      list.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
      setFamilias(list);
      return list;
    } catch (e) {
      setError((prev) => prev || errorMessage(e, 'Error cargando familias'));
      setFamilias([]);
      return [];
    } finally {
      setLoadingFamilias(false);
    }
  }, []);

  const guardarGrupo = useCallback(
    async (input: {
      id?: string;
      nombre: string;
      familiaIds: string[];
      orden?: number;
      activo?: boolean;
    }): Promise<MiaGrupoFamilias> => {
      const r = await apiFetch('/api/mia/grupos-familias', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await r.json();
      if (!r.ok || data.error || !data.item) {
        throw new Error(data.error || 'No se pudo guardar la agrupación');
      }
      const item = mapGrupo(data.item as Record<string, unknown>);
      if (!item) throw new Error('Respuesta inválida al guardar');
      return item;
    },
    [],
  );

  const borrarGrupo = useCallback(async (id: string): Promise<void> => {
    const sid = String(id || '').trim();
    if (!sid) throw new Error('id es obligatorio');
    const r = await apiFetch(`/api/mia/grupos-familias/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      throw new Error(data.error || 'No se pudo borrar la agrupación');
    }
  }, []);

  return {
    grupos,
    familias,
    loadingGrupos,
    loadingFamilias,
    error,
    setError,
    cargarGrupos,
    cargarFamilias,
    guardarGrupo,
    borrarGrupo,
  };
}
