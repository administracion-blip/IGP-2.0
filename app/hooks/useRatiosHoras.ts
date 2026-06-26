/**
 * Ratio de productividad (€ de facturación por hora de personal) configurable
 * por local. Se usa en RRHH → "Horas por facturación" para estimar las horas de
 * cuadrante posibles a partir del facturado comparativa.
 *
 * Persistencia: tabla genérica de ajustes (CRUD en `api/routes/ajustes.js`).
 *   PK = 'RATIO_HORAS_LOCAL'
 *   SK = id_Locales
 *   Campo: ratio (number, € por hora). 0 o ausente = sin configurar.
 *
 * Son globales (compartidos por todos los usuarios).
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch, errorMessage } from '../utils/api';

export const PK_RATIO_HORAS_LOCAL = 'RATIO_HORAS_LOCAL';

type AjusteItem = {
  SK?: string;
  ratio?: unknown;
};

function ratioDeItem(it: AjusteItem): number {
  const n = typeof it.ratio === 'number' ? it.ratio : Number(it.ratio);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function useRatiosHoras() {
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/ajustes?categoria=${encodeURIComponent(PK_RATIO_HORAS_LOCAL)}`);
      const data = await res.json();
      const items: AjusteItem[] = Array.isArray(data.items) ? data.items : [];
      const map: Record<string, number> = {};
      for (const it of items) {
        const id = String(it.SK ?? '');
        if (id) map[id] = ratioDeItem(it);
      }
      setRatios(map);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, 'Error al cargar ratios'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  /** Guarda (optimista) el ratio de un local. */
  const guardarRatio = useCallback(async (localId: string, ratio: number) => {
    const valor = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
    setRatios((prev) => ({ ...prev, [localId]: valor }));
    await apiFetch('/api/ajustes', {
      method: 'POST',
      body: JSON.stringify({ PK: PK_RATIO_HORAS_LOCAL, SK: localId, ratio: valor }),
    });
  }, []);

  return { ratios, loading, error, cargar, guardarRatio };
}
