/**
 * Agrupaciones de locales para el widget de Objetivos.
 *
 * Persistencia: tabla genérica de ajustes (CRUD en `api/routes/ajustes.js`).
 *   PK = 'AGRUPACION_OBJETIVOS'
 *   SK = id de la agrupación
 *   Campos: nombre, localIds (id_Locales), color, orden.
 *
 * Son globales (compartidas por todos los usuarios).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';

export const PK_AGRUPACIONES_OBJETIVOS = 'AGRUPACION_OBJETIVOS';

export type AgrupacionObjetivo = {
  id: string;
  nombre: string;
  localIds: string[];
  color: string;
  orden: number;
};

/** Colores de acento disponibles para diferenciar las agrupaciones en el widget. */
export const COLORES_AGRUPACION = [
  '#7c3aed',
  '#0ea5e9',
  '#db2777',
  '#ea580c',
  '#0d9488',
  '#4f46e5',
  '#65a30d',
  '#dc2626',
] as const;

type AjusteItem = {
  SK?: string;
  nombre?: unknown;
  localIds?: unknown;
  color?: unknown;
  orden?: unknown;
};

function mapItem(it: AjusteItem): AgrupacionObjetivo {
  return {
    id: String(it.SK ?? ''),
    nombre: typeof it.nombre === 'string' ? it.nombre : '',
    localIds: Array.isArray(it.localIds) ? it.localIds.map((x) => String(x)) : [],
    color: typeof it.color === 'string' && it.color ? it.color : COLORES_AGRUPACION[0],
    orden: typeof it.orden === 'number' ? it.orden : 0,
  };
}

export function nuevoIdAgrupacion(): string {
  return 'ag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function useAgrupacionesObjetivos() {
  const [agrupaciones, setAgrupaciones] = useState<AgrupacionObjetivo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/ajustes?categoria=${encodeURIComponent(PK_AGRUPACIONES_OBJETIVOS)}`);
      const data = await res.json();
      const items: AjusteItem[] = Array.isArray(data.items) ? data.items : [];
      const list = items
        .map(mapItem)
        .filter((a) => a.id)
        .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' }));
      setAgrupaciones(list);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Error al cargar agrupaciones'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const guardar = useCallback(
    async (a: AgrupacionObjetivo) => {
      await apiFetch('/api/ajustes', {
        method: 'POST',
        body: JSON.stringify({
          PK: PK_AGRUPACIONES_OBJETIVOS,
          SK: a.id,
          nombre: a.nombre,
          localIds: a.localIds,
          color: a.color,
          orden: a.orden,
        }),
      });
      await cargar();
    },
    [cargar],
  );

  const borrar = useCallback(
    async (id: string) => {
      await apiFetch(`/api/ajustes/${encodeURIComponent(PK_AGRUPACIONES_OBJETIVOS)}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      await cargar();
    },
    [cargar],
  );

  return { agrupaciones, loading, error, cargar, guardar, borrar };
}
