/**
 * Cálculos puros de venta mayorista (base imponible).
 * Servidor = fuente de verdad; el cliente puede reutilizar la misma lógica para UX.
 */

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

/** Cn desde línea de compra Ágora: Price × (1 − DiscountRate). Ignorar regalo (dto≈100%). */
export function costeNetoDesdeCompra(price, discountRate) {
  const p = Number(price) || 0;
  const d = Number(discountRate) || 0;
  if (d >= 0.999) return null;
  const cn = p * (1 - d);
  if (cn <= 0.001) return null;
  return round4(cn);
}

/** Días entre dos fechas ISO YYYY-MM-DD (fin − inicio), mínimo 0. */
export function diasEntre(fechaInicioIso, fechaFinIso) {
  const a = String(fechaInicioIso || '').slice(0, 10);
  const b = String(fechaFinIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return 0;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Recalcula una línea.
 * @param {object} input
 * @param {number} input.precioCompra — Pc operación (ya con override aplicado)
 * @param {number} [input.descuentoImporte] — D en € (si no se usa, 0; Pc ya puede ser neto)
 * @param {number} input.cantidad
 * @param {number} [input.pctGanancia] — ignorado (Mk.% es virtual; se deriva de PVP/PMR)
 * @param {number} [input.pvpUnitario] — PVP unitario (no se reescribe desde Mk.%)
 * @param {number} [input.aportacionUnitaria] — Au €/ud
 * @param {number} [input.tasaCapital] — anual (0.08 = 8%)
 * @param {number} [input.diasCobro]
 * @param {number} [input.margenMinimoAmbar] — % margen s/PVP; null = desactivado
 * @param {'pct'|'pvp'} [input.modoEdicion] — legado; Mk.% ya no manda sobre PVP
 */
export function recalcularLinea(input) {
  const pc = Math.max(0, Number(input.precioCompra) || 0);
  const d = Math.max(0, Number(input.descuentoImporte) || 0);
  const cn = Math.max(0, round4(pc - d));
  const cantidad = Math.max(0, Number(input.cantidad) || 0);
  const au = Math.max(0, Number(input.aportacionUnitaria) || 0);
  const tasa = Math.max(0, Number(input.tasaCapital) || 0);
  const dias = Math.max(0, Number(input.diasCobro) || 0);

  // PMR (precio medio real) = coste neto − aportación unitaria. Puede ser negativo.
  const pmr = round4(cn - au);

  // Mk.% es virtual: no reescribe PVP/coste/cantidad. Si no hay PVP, arranca en PMR (Mk%=0).
  let pvp = Number(input.pvpUnitario);
  if (!Number.isFinite(pvp)) pvp = pmr;
  pvp = round4(pvp);

  let pct = 0;
  if (Math.abs(pmr) > 0.0001) {
    pct = round2((pvp / pmr - 1) * 100);
  }

  // NETO = PVP − PMR (margen del markup sobre el PMR). Sin coste financiero.
  const benefNetoUd = round4(pvp - pmr);
  const benefCom = round2(benefNetoUd * cantidad);
  const aportAsig = round2(au * cantidad);
  const costeFin = round2(aportAsig * tasa * (dias / 365));
  const benefNeto = round2(benefNetoUd * cantidad);

  let alertaNivel = 'ok';
  let perdidaEstimada = 0;
  if (pvp < pmr - 0.0001) {
    alertaNivel = 'rojo';
    perdidaEstimada = round2((pmr - pvp) * cantidad);
  } else {
    const margenMin = input.margenMinimoAmbar;
    if (margenMin != null && Number.isFinite(Number(margenMin)) && pvp > 0) {
      const margenLinea = ((pvp - pmr) / pvp) * 100;
      if (margenLinea < Number(margenMin) && benefNeto >= 0) alertaNivel = 'ambar';
    }
  }

  return {
    coste_neto: cn,
    pmr,
    pct_ganancia: round2(pct),
    pvp_unitario: pvp,
    aportacion_unitaria: round4(au),
    aportacion_asignada: aportAsig,
    dias_cobro: dias,
    coste_financiero: costeFin,
    beneficio_comercial: benefCom,
    beneficio_neto: benefNeto,
    alerta_nivel: alertaNivel,
    perdida_estimada: perdidaEstimada,
  };
}

/** Agrega totales de operación a partir de líneas ya recalculadas. */
export function agregarTotales(lineas, umbrales = {}) {
  const costeTotal = round2(lineas.reduce((s, l) => s + (Number(l.coste_neto) || 0) * (Number(l.cantidad) || 0), 0));
  const ventaTotal = round2(lineas.reduce((s, l) => s + (Number(l.pvp_unitario) || 0) * (Number(l.cantidad) || 0), 0));
  const aportacionTotal = round2(lineas.reduce((s, l) => s + (Number(l.aportacion_asignada) || 0), 0));
  const costeFinancieroTotal = round2(lineas.reduce((s, l) => s + (Number(l.coste_financiero) || 0), 0));
  // NETO agregado = suma de netos de línea (PVP − PMR). Sin coste financiero.
  const beneficioNeto = round2(lineas.reduce((s, l) => s + (Number(l.beneficio_neto) || 0), 0));
  const beneficioComercial = beneficioNeto;

  const markupPct = costeTotal > 0 ? round2((beneficioComercial / costeTotal) * 100) : 0;
  const margenPct = ventaTotal > 0 ? round2((beneficioComercial / ventaTotal) * 100) : 0;
  const rentabilidadNetaPct = costeTotal > 0 ? round2((beneficioNeto / costeTotal) * 100) : 0;

  const verde = Number(umbrales.umbralVerde ?? 20);
  const ambar = Number(umbrales.umbralAmbar ?? 10);
  let semaforo = 'rojo';
  if (rentabilidadNetaPct >= verde) semaforo = 'verde';
  else if (rentabilidadNetaPct >= ambar) semaforo = 'ambar';

  return {
    coste_total: costeTotal,
    venta_total: ventaTotal,
    beneficio_comercial: beneficioComercial,
    aportacion_total: aportacionTotal,
    coste_financiero_total: costeFinancieroTotal,
    beneficio_neto: beneficioNeto,
    markup_pct: markupPct,
    margen_pct: margenPct,
    rentabilidad_neta_pct: rentabilidadNetaPct,
    semaforo,
  };
}
