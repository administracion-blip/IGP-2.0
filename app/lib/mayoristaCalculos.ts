/** Cálculos UX espejo del servidor (api/lib/mayorista/calculos.js). */

export function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function round4(n: number) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

export function costeNetoDesdeCompra(price: number, discountRate: number): number | null {
  const p = Number(price) || 0;
  const d = Number(discountRate) || 0;
  if (d >= 0.999) return null;
  const cn = p * (1 - d);
  if (cn <= 0.001) return null;
  return round4(cn);
}

export function recalcularLineaUx(input: {
  precioCompra: number;
  descuentoImporte?: number;
  cantidad: number;
  pctGanancia?: number;
  pvpUnitario?: number;
  aportacionUnitaria?: number;
  tasaCapital?: number;
  diasCobro?: number;
  /** Legado: Mk.% es virtual y nunca reescribe PVP. */
  modoEdicion?: 'pct' | 'pvp';
}) {
  const pc = Math.max(0, Number(input.precioCompra) || 0);
  const d = Math.max(0, Number(input.descuentoImporte) || 0);
  const cn = Math.max(0, round4(pc - d));
  const cantidad = Math.max(0, Number(input.cantidad) || 0);
  const au = Math.max(0, Number(input.aportacionUnitaria) || 0);
  const tasa = Math.max(0, Number(input.tasaCapital) || 0);
  const dias = Math.max(0, Number(input.diasCobro) || 0);

  // PMR (precio medio real) = coste neto − aportación unitaria. Puede ser negativo.
  const pmr = round4(cn - au);

  // Mk.% virtual: no reescribe PVP/coste/cantidad. Sin PVP → PMR (Mk%=0).
  let pvp = Number(input.pvpUnitario);
  if (!Number.isFinite(pvp)) pvp = pmr;
  pvp = round4(pvp);

  let pct = 0;
  if (Math.abs(pmr) > 0.0001) {
    pct = round2((pvp / pmr - 1) * 100);
  }

  // NETO = PVP − PMR (margen del markup sobre el PMR). Sin coste financiero.
  const benefNetoUd = round4(pvp - pmr);
  const aportAsig = round2(au * cantidad);
  const costeFin = round2(aportAsig * tasa * (dias / 365));
  const benefNeto = round2(benefNetoUd * cantidad);

  return {
    coste_neto: cn,
    pmr,
    pct_ganancia: pct,
    pvp_unitario: pvp,
    aportacion_asignada: aportAsig,
    coste_financiero: costeFin,
    beneficio_comercial: benefNeto,
    beneficio_neto: benefNeto,
    alerta_nivel: (pvp < pmr - 0.0001 ? 'rojo' : 'ok') as 'rojo' | 'ok' | 'ambar',
    perdida_estimada: pvp < pmr ? round2((pmr - pvp) * cantidad) : 0,
  };
}

export function formatEur(n: number | null | undefined, digitos = 2) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `${Number(n).toLocaleString('es-ES', { minimumFractionDigits: digitos, maximumFractionDigits: digitos })} €`;
}
