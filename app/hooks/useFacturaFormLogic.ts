import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LineaFactura } from '../utils/facturacion';
import {
  calcularFechaVencimientoDmy,
  emptyLinea,
  hoyDmy,
  addLineaToArray,
  removeLineaFromArray,
  totalesFromLineas,
  updateLineaInArray,
} from '../utils/facturaFormLogic';

export type UseFacturaFormLogicOptions = {
  modo: 'crear' | 'editar';
  /** Mientras true no se recalcula vencimiento (p. ej. fetch en curso). */
  loading: boolean;
  /**
   * Fecha emisión inicial en dmy. Si se omite, se usa hoy (comportamiento típico «crear»).
   * El panel puede pasar '' hasta hidratar desde API.
   */
  initialFechaEmision?: string;
};

export function useFacturaFormLogic(options: UseFacturaFormLogicOptions) {
  const { loading, initialFechaEmision } = options;

  const [fechaEmision, setFechaEmision] = useState(() =>
    initialFechaEmision !== undefined ? initialFechaEmision : hoyDmy(),
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

    const nueva = calcularFechaVencimientoDmy(fechaEmision, condicionesPago);
    if (nueva) setFechaVencimiento(nueva);
  }, [condicionesPago, fechaEmision, loading]);

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
