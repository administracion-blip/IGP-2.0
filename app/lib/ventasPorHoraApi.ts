/**
 * Ventas por horas y plantillas de franjas (módulo Cajas → Objetivos).
 *
 * - Plantillas de franjas: tabla DynamoDB Igp_FranjasHorarias (PK="GLOBAL", SK=plantillaId).
 *   Cada plantilla agrupa franjas con nombre, reutilizables y seleccionables a mano.
 * - Ventas por hora: se calculan en backend desde las facturas de Ágora de un business-day
 *   (endpoint /api/agora/invoices/sales-by-hour) y aquí se agrupan según la plantilla elegida.
 */
import { apiFetch } from '../utils/api';

export type Franja = {
  desde: string; // "HH:MM"
  hasta: string; // "HH:MM"
  etiqueta?: string;
};

export type PlantillaFranjas = {
  plantillaId: string;
  nombre: string;
  franjas: Franja[];
};

export type VentasPorHora = {
  businessDay: string;
  workplaceId: string;
  /** Mapa hora (0-23) → importe bruto. */
  porHora: Record<string, number>;
  totalDia: number;
  nFacturas: number;
};

/** Fila resultante de agrupar ventas por hora en una franja, con real y comparativa. */
export type FilaFranja = {
  franja: Franja;
  label: string;
  real: number;
  comparativa: number;
  desvio: number;
  desvioPct: number | null;
};

export async function obtenerPlantillasFranjas(): Promise<PlantillaFranjas[]> {
  const res = await apiFetch('/api/agora/franjas-plantillas');
  if (!res.ok) throw new Error('No se pudieron cargar las plantillas de franjas');
  const data = await res.json();
  return Array.isArray(data.plantillas) ? data.plantillas : [];
}

export async function crearPlantillaFranjas(nombre: string, franjas: Franja[]): Promise<PlantillaFranjas> {
  const res = await apiFetch('/api/agora/franjas-plantillas', {
    method: 'POST',
    body: JSON.stringify({ nombre, franjas }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'No se pudo crear la plantilla');
  }
  const data = await res.json();
  return data.plantilla;
}

export async function actualizarPlantillaFranjas(
  plantillaId: string,
  nombre: string,
  franjas: Franja[],
): Promise<PlantillaFranjas> {
  const res = await apiFetch('/api/agora/franjas-plantillas', {
    method: 'PUT',
    body: JSON.stringify({ plantillaId, nombre, franjas }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'No se pudo actualizar la plantilla');
  }
  const data = await res.json();
  return data.plantilla;
}

export async function borrarPlantillaFranjas(plantillaId: string): Promise<void> {
  const res = await apiFetch(`/api/agora/franjas-plantillas?plantillaId=${encodeURIComponent(plantillaId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'No se pudo borrar la plantilla');
  }
}

export async function obtenerVentasPorHora(workplaceId: string, businessDay: string): Promise<VentasPorHora> {
  const res = await apiFetch(
    `/api/agora/invoices/sales-by-hour?workplaceId=${encodeURIComponent(workplaceId)}&businessDay=${businessDay}`,
    { timeoutMs: 60000 },
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || 'No se pudieron obtener las ventas por hora');
  }
  return res.json();
}

/** "HH:MM" → minutos desde medianoche. */
function aMinutos(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

/**
 * Suma el importe de un mapa hora→importe dentro de una franja [desde, hasta).
 * Si `hasta` <= `desde` (franja nocturna, p. ej. 22:00→02:00) se considera que cruza medianoche.
 * El reparto es por hora completa (granularidad del dato de Ágora).
 */
function sumarFranja(porHora: Record<string, number>, franja: Franja): number {
  const ini = aMinutos(franja.desde);
  const fin = aMinutos(franja.hasta);
  const cruzaMedianoche = fin <= ini;
  let total = 0;
  for (let h = 0; h <= 23; h++) {
    const minutoHora = h * 60;
    const dentro = cruzaMedianoche
      ? minutoHora >= ini || minutoHora < fin
      : minutoHora >= ini && minutoHora < fin;
    if (dentro) total += porHora[String(h)] ?? 0;
  }
  return total;
}

function etiquetaFranja(franja: Franja): string {
  const rango = `${franja.desde}–${franja.hasta}`;
  return franja.etiqueta ? `${franja.etiqueta} (${rango})` : rango;
}

/** Agrupa las ventas por hora (real y comparativa) en las franjas de la plantilla elegida. */
export function agruparEnFranjas(
  real: Record<string, number>,
  comparativa: Record<string, number>,
  franjas: Franja[],
): FilaFranja[] {
  return franjas.map((franja) => {
    const r = sumarFranja(real, franja);
    const c = sumarFranja(comparativa, franja);
    const desvio = r - c;
    const desvioPct = c === 0 ? null : r / c - 1;
    return { franja, label: etiquetaFranja(franja), real: r, comparativa: c, desvio, desvioPct };
  });
}
