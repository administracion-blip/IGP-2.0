import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import type { Borrador, EmpresaCatalogo } from '../types/registroMasivo';
import type { ReconciliacionDatos } from '../lib/registroMasivo';

/**
 * Hook que encapsula el bloque "Empresa (GRUPO PARIPE)" del registro masivo:
 * filtra el catálogo de empresas para mostrar solo las del grupo, gestiona
 * el dropdown de búsqueda y dispara la reconciliación contra el documento
 * cuando se asigna una sociedad a un borrador con `entidades_candidatas`.
 *
 * El padre sigue siendo dueño de `empresasCatalogo` (porque otros componentes
 * lo consumen, p. ej. `ProveedorDropdownField`); este hook solo lo lee.
 *
 * Mutaciones en `borradores`:
 * - `onSociedadAsignada(idx, sociedad)`: el padre fija sociedad_grupo_*.
 * - `onReconciliacion(idx, datos)`: el padre aplica `mergeReconciliacion`.
 */
export type SociedadAsignada = {
  id: string;
  nombre: string;
  cif: string;
};

export type UseEmpresasGrupoReturn = {
  empresasGrupoParipe: EmpresaCatalogo[];
  empresasGrupoFiltradas: EmpresaCatalogo[];
  search: string;
  setSearch: (s: string) => void;
  showDropdown: boolean;
  setShowDropdown: (v: boolean) => void;
  /** True si el catálogo backend cargó al menos una empresa. */
  hayCatalogo: boolean;
  /** True si en el catálogo hay empresas con sede "GRUPO PARIPE". */
  hayGrupoParipe: boolean;
  /**
   * Asigna `e` como sociedad receptora del borrador `idx`. Si `prevRow`
   * tiene `entidades_candidatas`, lanza la reconciliación OCR y propaga
   * el resultado vía `onReconciliacion`. Cualquier error se reporta con
   * `onError`.
   */
  seleccionar: (idx: number, e: EmpresaCatalogo, prevRow: Borrador | null) => Promise<void>;
};

export function useEmpresasGrupo(opts: {
  empresasCatalogo: EmpresaCatalogo[];
  /** Cambios en `selectedIdx` resetean búsqueda y dropdown. */
  selectedIdx: number | null;
  onSociedadAsignada: (idx: number, sociedad: SociedadAsignada) => void;
  onReconciliacion: (idx: number, datos: ReconciliacionDatos) => void;
  onError?: (msg: string) => void;
}): UseEmpresasGrupoReturn {
  const [search, setSearch] = useState<string>('');
  const [showDropdown, setShowDropdown] = useState<boolean>(false);

  const empresasGrupoParipe = useMemo(
    () => opts.empresasCatalogo.filter((e) => (e?.Sede || '').toUpperCase().includes('GRUPO PARIPE')),
    [opts.empresasCatalogo],
  );

  const empresasGrupoFiltradas = useMemo(() => {
    if (!search.trim()) return empresasGrupoParipe;
    const q = search.toLowerCase();
    return empresasGrupoParipe.filter(
      (e) => (e.Nombre || '').toLowerCase().includes(q) || (e.Cif || '').toLowerCase().includes(q),
    );
  }, [empresasGrupoParipe, search]);

  useEffect(() => {
    setSearch('');
    setShowDropdown(false);
  }, [opts.selectedIdx]);

  const seleccionar = useCallback(
    async (idx: number, e: EmpresaCatalogo, prevRow: Borrador | null) => {
      const sociedad: SociedadAsignada = {
        id: e.id_empresa != null ? String(e.id_empresa) : '',
        nombre: e.Nombre != null ? String(e.Nombre) : '',
        cif: e.Cif != null ? String(e.Cif) : '',
      };

      opts.onSociedadAsignada(idx, sociedad);
      setSearch('');
      setShowDropdown(false);

      if (!prevRow?.entidades_candidatas?.length) return;

      try {
        const res = await apiFetch(`/api/facturacion/ocr/reconciliar`, {
          method: 'POST',
          body: JSON.stringify({
            sociedad_cif: sociedad.cif,
            sociedad_nombre: sociedad.nombre,
            entidades_candidatas: prevRow.entidades_candidatas,
            texto_extraido: prevRow.texto_extraido || '',
            extraction_snapshot: prevRow.extraction_snapshot,
            campos_manuales: prevRow.campos_manuales || {},
            proveedor_provisional_cif:
              prevRow.proveedor_provisional_cif || prevRow.extraction_snapshot?.proveedor_cif || '',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Reconciliación fallida');
        const d: ReconciliacionDatos | undefined = data.datos;
        if (!d) return;
        opts.onReconciliacion(idx, d);
      } catch (err: unknown) {
        opts.onError?.(errorMessage(err, 'No se pudo reconciliar con el documento'));
      }
    },
    [opts],
  );

  return {
    empresasGrupoParipe,
    empresasGrupoFiltradas,
    search,
    setSearch,
    showDropdown,
    setShowDropdown,
    hayCatalogo: opts.empresasCatalogo.length > 0,
    hayGrupoParipe: empresasGrupoParipe.length > 0,
    seleccionar,
  };
}
