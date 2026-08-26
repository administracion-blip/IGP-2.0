/**
 * Cambio de estado de una tarea, con el paso extra del motivo cuando el destino
 * es `bloqueada`.
 *
 * Lo comparten la vista personal y las dos fichas para que el trato de los
 * errores sea el mismo en todas: `422` es una transición que el estado actual no
 * admite y se enseña el mensaje del backend; `404` significa que la tarea ya no
 * está disponible —no que falte permiso— y se avisa al llamante para que la
 * saque de la lista.
 */
import { useCallback, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';
import { ESTADOS_TAREA_TERMINALES, type EstadoTarea, type Tarea } from '../types/tasks';

const TERMINALES: readonly string[] = ESTADOS_TAREA_TERMINALES;

export type CambioEstadoTarea = {
  /** Tarea y destino con el cambio en vuelo, para el indicador del botón. */
  enCurso: { idTarea: string; destino: EstadoTarea } | null;
  error: string | null;
  descartarError: () => void;
  /** Tarea pendiente de motivo de bloqueo (abre `ModalMotivoBloqueo`). */
  tareaBloqueo: Tarea | null;
  pedirCambio: (tarea: Tarea, destino: EstadoTarea) => void;
  confirmarBloqueo: (motivo: string) => void;
  cancelarBloqueo: () => void;
};

export function useCambioEstadoTarea({
  onCambiada,
  onNoDisponible,
}: {
  onCambiada: (tarea: Tarea, contexto: { terminal: boolean; anterior: Tarea }) => void;
  onNoDisponible?: (idTarea: string) => void;
}): CambioEstadoTarea {
  const [enCurso, setEnCurso] = useState<{ idTarea: string; destino: EstadoTarea } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tareaBloqueo, setTareaBloqueo] = useState<Tarea | null>(null);

  const cambiar = useCallback(
    async (tarea: Tarea, destino: EstadoTarea, motivo?: string): Promise<boolean> => {
      setEnCurso({ idTarea: tarea.id_tarea, destino });
      setError(null);
      try {
        const res = await apiFetch(`/api/tareas/${encodeURIComponent(tarea.id_tarea)}/estado`, {
          method: 'POST',
          body: JSON.stringify({ estado: destino, ...(motivo ? { bloqueo_motivo: motivo } : {}) }),
        });
        const data = (await res.json().catch(() => ({}))) as { tarea?: Tarea; error?: string };

        if (res.status === 404) {
          setError('Esa tarea ya no está disponible.');
          onNoDisponible?.(tarea.id_tarea);
          return false;
        }
        if (!res.ok || !data.tarea) {
          setError(data.error || 'No se pudo cambiar el estado de la tarea');
          return false;
        }
        onCambiada(data.tarea, {
          terminal: TERMINALES.includes(data.tarea.estado),
          anterior: tarea,
        });
        return true;
      } catch (e) {
        console.error('[tasks] fallo al cambiar el estado de la tarea', e);
        setError(errorMessage(e, 'No se pudo conectar con el servidor'));
        return false;
      } finally {
        setEnCurso(null);
      }
    },
    [onCambiada, onNoDisponible],
  );

  const pedirCambio = useCallback(
    (tarea: Tarea, destino: EstadoTarea) => {
      setError(null);
      if (destino === 'bloqueada') {
        setTareaBloqueo(tarea);
        return;
      }
      void cambiar(tarea, destino);
    },
    [cambiar],
  );

  const confirmarBloqueo = useCallback(
    (motivo: string) => {
      const tarea = tareaBloqueo;
      if (!tarea) return;
      void cambiar(tarea, 'bloqueada', motivo).then((ok) => {
        if (ok) setTareaBloqueo(null);
      });
    },
    [tareaBloqueo, cambiar],
  );

  return {
    enCurso,
    error,
    descartarError: useCallback(() => setError(null), []),
    tareaBloqueo,
    pedirCambio,
    confirmarBloqueo,
    cancelarBloqueo: useCallback(() => setTareaBloqueo(null), []),
  };
}
