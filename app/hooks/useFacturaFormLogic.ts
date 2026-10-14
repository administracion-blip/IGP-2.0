import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineaFactura } from '../utils/facturacion';
import {
  calcularFechaVencimientoIso,
  emptyLinea,
  hoyISO,
  addLineaToArray,
  removeLineaFromArray,
  totalesFromLineas,
  updateLineaInArray,
} from '../utils/facturaFormLogic';
import { condicionesDesdeDias } from '../utils/plazoVencimiento';

export type UseFacturaFormLogicOptions = {
  modo: 'crear' | 'editar';
  /** Mientras true no se recalcula vencimiento (p. ej. fetch en curso). */
  loading: boolean;
  /**
   * Fecha emisión inicial en ISO yyyy-mm-dd. Si se omite, se usa hoy (comportamiento típico «crear»).
   * El panel puede pasar '' hasta hidratar desde API.
   */
  initialFechaEmision?: string;
  /** Si true, el vencimiento no se recalcula al cambiar emisión/condiciones (editado a mano). */
  vencimientoManual?: boolean;
  /**
   * Días a usar cuando `condicionesPago` está vacío (p. ej. plazo del proveedor en IN).
   * Cambiarlo no recalcula por sí solo: solo se usa en el siguiente recálculo.
   */
  diasPlazoDefecto?: number | null;
};

export function useFacturaFormLogic(options: UseFacturaFormLogicOptions) {
  const { loading, initialFechaEmision, vencimientoManual = false, diasPlazoDefecto = null } = options;
  const diasPlazoDefectoRef = useRef(diasPlazoDefecto);
  diasPlazoDefectoRef.current = diasPlazoDefecto;

  const [fechaEmision, setFechaEmision] = useState(() =>
    initialFechaEmision !== undefined ? initialFechaEmision : hoyISO(),
  );
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [condicionesPago, setCondicionesPago] = useState('contado');
  const [formaPago, setFormaPago] = useState('transferencia');
  const [lineas, setLineas] = useState<LineaFactura[]>([emptyLinea()]);

  const skipVencimientoSyncRef = useRef(false);

  const markHydrationFromApi = useCallback(() => {
    skipVencimientoSyncRef.current = true;
  }, []);

  const totales = useMemo(() => totalesFromLineas(lineas), [lineas]);

  const updateLinea = useCallback((idx: number, field: keyof LineaFactura, value: string) => {
    setLineas((prev) => updateLineaInArray(prev, idx, field, value));
  }, []);

  const addLinea = useCallback(() => {
    setLineas((prev) => addLineaToArray(prev));
  }, []);

  const removeLinea = useCallback((idx: number) => {
    setLineas((prev) => removeLineaFromArray(prev, idx));
  }, []);

  useEffect(() => {
    if (loading) return;

    if (skipVencimientoSyncRef.current) {
      skipVencimientoSyncRef.current = false;
      return;
    }
    if (vencimientoManual) return;

    const diasDefecto = !condicionesPago.trim() ? diasPlazoDefectoRef.current : null;
    const nueva = calcularFechaVencimientoIso(
      fechaEmision,
      diasDefecto != null ? condicionesDesdeDias(diasDefecto) : condicionesPago,
    );
    if (nueva) setFechaVencimiento(nueva);
  }, [condicionesPago, fechaEmision, loading, vencimientoManual]);

  return {
    fechaEmision,
    setFechaEmision,
    fechaVencimiento,
    setFechaVencimiento,
    condicionesPago,
    setCondicionesPago,
    formaPago,
    setFormaPago,
    lineas,
    setLineas,
    totales,
    updateLinea,
    addLinea,
    removeLinea,
    markHydrationFromApi,
  };
}
