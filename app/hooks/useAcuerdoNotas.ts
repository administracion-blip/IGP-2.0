import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Acuerdo } from '../types/acuerdo';
import { apiFetch, errorMessage } from '../utils/api';
import {
  eliminarNotaPorOrden,
  notasTimelineOrdenadas,
  prependNota,
  resumenNotas,
} from '../lib/acuerdoNotas';

type Args = {
  /** Acuerdo cuyas notas se editan. Si pasa a `null` el modal se cierra automáticamente. */
  seleccionado: Acuerdo | null;
  /** Callback ejecutado tras guardar exitosamente (típicamente recargar listado). */
  onSaved: () => Promise<void> | void;
};

export type UseAcuerdoNotasReturn = ReturnType<typeof useAcuerdoNotas>;

/**
 * Lógica del modal timeline de notas de un acuerdo.
 * Añade / elimina notas y mantiene el campo `Notas` en backend.
 * La confirmación de borrado la hace la UI con `useConfirmar` (modal in-app).
 */
export function useAcuerdoNotas({ seleccionado, onSaved }: Args) {
  const [visible, setVisible] = useState(false);
  const [nuevaNota, setNuevaNota] = useState('');
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!seleccionado) setVisible(false);
  }, [seleccionado]);

  const textoNotas = seleccionado?.Notas || '';

  const lineas = useMemo(
    () => (visible ? notasTimelineOrdenadas(textoNotas) : []),
    [visible, textoNotas],
  );

  const resumen = useMemo(() => resumenNotas(textoNotas), [textoNotas]);

  const abrir = useCallback(() => {
    if (!seleccionado) return;
    setNuevaNota('');
    setError('');
    setVisible(true);
  }, [seleccionado]);

  const cerrar = useCallback(() => {
    if (guardando) return;
    setVisible(false);
    setNuevaNota('');
  }, [guardando]);

  const añadirNota = useCallback(async () => {
    if (!seleccionado) return;
    const t = nuevaNota.trim();
    if (!t) {
      setError('Escribe el texto de la nota');
      return;
    }
    setGuardando(true);
    setError('');
    const siguiente = prependNota(seleccionado.Notas || '', t);
    try {
      const res = await apiFetch(`/api/acuerdos/${encodeURIComponent(seleccionado.PK)}`, {
        method: 'PATCH',
        body: JSON.stringify({ Notas: siguiente }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al guardar');
      setNuevaNota('');
      await onSaved();
    } catch (e: unknown) {
      setError(errorMessage(e, 'Error'));
    } finally {
      setGuardando(false);
    }
  }, [seleccionado, nuevaNota, onSaved]);

  /** Elimina sin diálogo: la confirmación in-app la hace el modal con `useConfirmar`. */
  const eliminarNota = useCallback(
    async (ordenOriginal: number) => {
      if (!seleccionado) return;
      setGuardando(true);
      setError('');
      const siguiente = eliminarNotaPorOrden(seleccionado.Notas || '', ordenOriginal);
      try {
        const res = await apiFetch(`/api/acuerdos/${encodeURIComponent(seleccionado.PK)}`, {
          method: 'PATCH',
          body: JSON.stringify({ Notas: siguiente }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error al eliminar');
        await onSaved();
      } catch (e: unknown) {
        setError(errorMessage(e, 'Error al eliminar'));
      } finally {
        setGuardando(false);
      }
    },
    [seleccionado, onSaved],
  );

  return {
    visible,
    nuevaNota,
    setNuevaNota,
    error,
    guardando,
    lineas,
    resumen,
    abrir,
    cerrar,
    añadirNota,
    eliminarNota,
  };
}
