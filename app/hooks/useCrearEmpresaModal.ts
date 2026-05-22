import { useCallback, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import type { Borrador } from '../types/registroMasivo';

/**
 * Hook que encapsula el modal "Crear empresa desde OCR" del registro masivo.
 *
 * Responsabilidades:
 * - Estado UI (visibilidad, nombre editable, flag guardando).
 * - Snapshot del CIF y del idx del borrador al abrir el modal (el modal
 *   no permite editarlos en su flujo, así que es seguro fijarlos).
 * - Llamada a `POST /api/empresas` y propagación del resultado al padre
 *   vía callbacks `onCreated`, `onSuccess`, `onError`.
 *
 * El padre es responsable de mutar el array de `borradores` en respuesta
 * al éxito (vía `onCreated(idx, emp, nombre)`); el hook nunca muta estado
 * del padre directamente, lo que lo mantiene desacoplado.
 */

export type EmpresaCreada = { Nombre?: string; id_empresa?: string };

export type UseCrearEmpresaModalReturn = {
  visible: boolean;
  /** CIF del borrador para el que se está creando la empresa (solo lectura). */
  cif: string;
  nombre: string;
  setNombre: (s: string) => void;
  guardando: boolean;
  abrir: (b: Borrador) => void;
  cerrar: () => void;
  guardar: () => Promise<void>;
};

export function useCrearEmpresaModal(opts: {
  /** Llamado cuando la empresa se crea correctamente. El padre hace el merge en `borradores`. */
  onCreated: (idx: number, emp: EmpresaCreada, nombre: string) => void;
  /** Mensaje de error (UX). Si se omite, el error solo se descarta. */
  onError?: (msg: string) => void;
  /** Mensaje de éxito (UX, p. ej. toast). */
  onSuccess?: (msg: string) => void;
}): UseCrearEmpresaModalReturn {
  const [idx, setIdx] = useState<number | null>(null);
  const [cif, setCif] = useState<string>('');
  const [nombre, setNombre] = useState<string>('');
  const [guardando, setGuardando] = useState<boolean>(false);

  const abrir = useCallback((b: Borrador) => {
    setIdx(b.idx);
    setCif(b.proveedor_cif || '');
    setNombre((b.nombre_sugerido_ocr || '').trim());
  }, []);

  const cerrar = useCallback(() => {
    setIdx(null);
    setCif('');
    setNombre('');
    setGuardando(false);
  }, []);

  const guardar = useCallback(async () => {
    if (idx == null || !cif) return;
    const nombreLimpio = nombre.trim();
    if (!nombreLimpio) {
      opts.onError?.('Indica el nombre de la empresa para darla de alta.');
      return;
    }
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/empresas`, {
        method: 'POST',
        body: JSON.stringify({ Nombre: nombreLimpio, Cif: cif }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'No se pudo crear la empresa');
      const emp: EmpresaCreada = data.empresa || {};
      opts.onCreated(idx, emp, nombreLimpio);
      opts.onSuccess?.(`${nombreLimpio} vinculada al CIF ${cif}`);
      setIdx(null);
      setCif('');
      setNombre('');
    } catch (e: unknown) {
      opts.onError?.(errorMessage(e, 'Error al crear empresa'));
    } finally {
      setGuardando(false);
    }
  }, [idx, cif, nombre, opts]);

  return {
    visible: idx !== null,
    cif,
    nombre,
    setNombre,
    guardando,
    abrir,
    cerrar,
    guardar,
  };
}
