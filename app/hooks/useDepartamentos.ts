/**
 * Maestro de departamentos para desplegables y para resolver nombres.
 *
 * La lectura solo pide sesión, así que no hay que ocultar nada por permisos. Se
 * carga la lista completa —no solo los activos— porque los inactivos siguen
 * teniendo que resolver el nombre de lo ya grabado; en las opciones del
 * formulario solo entran los activos.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../utils/api';
import type { OpcionDesplegable } from '../components/SelectorDesplegable';
import type { Departamento } from '../types/tasks';

export type MaestroDepartamentos = {
  departamentos: Departamento[];
  /** Solo los activos, ordenados por `orden` y nombre. */
  opciones: OpcionDesplegable[];
  nombrePorId: (id?: string | null) => string;
  cargando: boolean;
};

export function useDepartamentos(): MaestroDepartamentos {
  const [departamentos, setDepartamentos] = useState<Departamento[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let cancelado = false;
    apiFetch('/api/departamentos')
      .then((r) => r.json())
      .then((data: { departamentos?: Departamento[]; error?: string }) => {
        if (cancelado) return;
        setDepartamentos(Array.isArray(data.departamentos) ? data.departamentos : []);
      })
      .catch((e) => {
        if (cancelado) return;
        console.error('[tasks] no se pudo leer el maestro de departamentos', e);
        setDepartamentos([]);
      })
      .finally(() => {
        if (!cancelado) setCargando(false);
      });
    return () => {
      cancelado = true;
    };
  }, []);

  const nombrePorId = useCallback(
    (id?: string | null): string => {
      const clave = (id ?? '').trim();
      if (!clave) return '—';
      return departamentos.find((d) => d.id === clave)?.nombre ?? 'Departamento eliminado';
    },
    [departamentos],
  );

  const opciones = useMemo<OpcionDesplegable[]>(
    () =>
      departamentos
        .filter((d) => d.activo !== false)
        .map((d) => ({ id: d.id, titulo: d.nombre, icono: 'account-tree' as const, orden: d.orden ?? 0 }))
        .sort((a, b) => a.orden - b.orden || a.titulo.localeCompare(b.titulo, 'es'))
        .map(({ orden: _orden, ...opcion }) => opcion),
    [departamentos],
  );

  return { departamentos, opciones, nombrePorId, cargando };
}
