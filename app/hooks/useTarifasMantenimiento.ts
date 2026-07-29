/**
 * Tarifas del servicio de mantenimiento: precio por kilómetro del
 * desplazamiento del técnico e importe por hora de mano de obra. Son los
 * valores por defecto que precargan la valoración de una reparación.
 *
 * Persistencia: tabla genérica de ajustes (CRUD en `api/routes/ajustes.js`).
 *   PK = 'mantenimiento'
 *   SK = 'desplazamiento'
 *   Campos: precio_km, importe_hora
 *
 * No confundir con `ImporteHoraDefecto` (PK='personalizacion'), que es el coste
 * de personal usado en RRHH → Horas por facturación.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';

export const PK_TARIFAS_MANTENIMIENTO = 'mantenimiento';
export const SK_TARIFAS_MANTENIMIENTO = 'desplazamiento';

/** Precio por kilómetro de desplazamiento cuando no hay ajuste guardado. */
export const PRECIO_KM_DEFECTO = 7.25;
/** Precio por hora de mano de obra cuando no hay ajuste guardado. */
export const IMPORTE_HORA_DEFECTO = 30;

export type TarifasMantenimiento = {
  precioKm: number;
  importeHora: number;
};

const TARIFAS_DEFECTO: TarifasMantenimiento = {
  precioKm: PRECIO_KM_DEFECTO,
  importeHora: IMPORTE_HORA_DEFECTO,
};

/** Acepta número o cadena (con coma o punto); 0, vacío o basura ⇒ valor por defecto. */
function tarifa(v: unknown, defecto: number): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : defecto;
}

export function useTarifasMantenimiento() {
  const [tarifas, setTarifas] = useState<TarifasMantenimiento>(TARIFAS_DEFECTO);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/ajustes/${PK_TARIFAS_MANTENIMIENTO}/${SK_TARIFAS_MANTENIMIENTO}`,
      );
      // 404 = todavía no se han configurado: se trabaja con los valores por defecto.
      if (res.status === 404) {
        setTarifas(TARIFAS_DEFECTO);
        return;
      }
      const data = (await res.json()) as { item?: Record<string, unknown>; error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? 'No se pudieron cargar las tarifas de mantenimiento');
        return;
      }
      const item = data.item ?? {};
      setTarifas({
        precioKm: tarifa(item.precio_km, PRECIO_KM_DEFECTO),
        importeHora: tarifa(item.importe_hora, IMPORTE_HORA_DEFECTO),
      });
    } catch (e) {
      setError(errorMessage(e, 'No se pudieron cargar las tarifas de mantenimiento'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /**
   * Guarda las tarifas. Devuelve el mensaje de error, o `null` si fue bien.
   * PATCH y no POST: el POST reemplaza el ítem completo y machacaría cualquier
   * otro atributo que llegue a tener el ajuste.
   */
  const guardar = useCallback(async (next: TarifasMantenimiento): Promise<string | null> => {
    try {
      const res = await apiFetch(
        `/api/ajustes/${PK_TARIFAS_MANTENIMIENTO}/${SK_TARIFAS_MANTENIMIENTO}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            precio_km: next.precioKm,
            importe_hora: next.importeHora,
          }),
        },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) return data.error ?? 'No se pudieron guardar las tarifas';
      setTarifas(next);
      return null;
    } catch (e) {
      return errorMessage(e, 'Error de conexión al guardar las tarifas');
    }
  }, []);

  return { tarifas, loading, error, cargar, guardar };
}
