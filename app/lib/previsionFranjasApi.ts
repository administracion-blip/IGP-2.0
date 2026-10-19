/**
 * Previsión de ventas por franjas (Cajas → Previsión).
 *
 * La previsión de cada día es la venta real de su fecha comparativa (tabla de
 * festivos o mismo día del año anterior) repartida en las franjas de una plantilla.
 * Backend: `api/routes/prevision.js`.
 */
import { apiFetch } from '../utils/api';

export const MAX_DIAS_PREVISION = 62;
export const OBJETIVO_EUR_EMP_HORA_DEFECTO = 120;

export type FranjaPrevision = {
  desde: string;
  hasta: string;
  etiqueta: string;
  label: string;
  horas: number;
};

export type PlantillaPrevision = {
  plantillaId: string;
  nombre: string;
  franjas: FranjaPrevision[];
};

export type MotivoDiaNoValido = 'comparativa_no_anterior' | 'sin_ventas' | 'error_agora' | 'pendiente';

export type CeldaPrevision = {
  previsto: number;
  personal: number;
  real: number | null;
  desvioPct: number | null;
};

export type DiaPrevision = {
  fecha: string;
  pasado: boolean;
  fechaComparativa: string;
  origenComparativa: 'festivo' | 'anio_anterior';
  festivo: { nombre: string } | null;
  nombreFestivoComparativa: string | null;
  valida: boolean;
  motivo: MotivoDiaNoValido | null;
  celdas: CeldaPrevision[];
  totalPrevisto: number;
  totalReal: number | null;
  /** Ratio: 0.059 = +5,9 %. */
  desvioPct: number | null;
  fueraDeFranjas: number;
};

export type KpisPrevision = {
  ventaPrevista: number;
  ventaRealPasados: number | null;
  desvioPct: number | null;
  franjaMasFuerte: { label: string; importe: number } | null;
  diaMasFuerte: { fecha: string; importe: number } | null;
  picoPersonal: { fecha: string; label: string; personas: number } | null;
};

export type LocalPrevision = {
  workplaceId: string;
  idLocal: string | null;
  nombre: string;
  kpis: KpisPrevision;
  dias: DiaPrevision[];
};

export type ResultadoPrevision = {
  plantilla: PlantillaPrevision;
  hoyJornada: string;
  pendientes: number;
  avisos: string[];
  locales: LocalPrevision[];
};

export type PeticionPrevision = {
  fechaDesde: string;
  fechaHasta: string;
  diasExcluidos: string[];
  workplaceIds: string[];
  plantillaId: string;
  objetivoEurEmpHora: number;
};

export type AmbitoEscenario = 'propio' | 'global';

export type EscenarioPrevision = PeticionPrevision & {
  id: string;
  ambito: AmbitoEscenario;
  nombre: string;
  creadoPor?: string;
  creadoEn?: string;
  actualizadoEn?: string;
};

export type DatosEscenario = PeticionPrevision & { nombre: string; ambito: AmbitoEscenario };

export const TEXTO_MOTIVO: Record<MotivoDiaNoValido, string> = {
  comparativa_no_anterior: 'Sin comparativa válida',
  sin_ventas: 'La fecha comparativa no tiene ventas',
  error_agora: 'Error al consultar Ágora',
  pendiente: 'Pendiente de completar histórico',
};

async function leerError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export async function calcularPrevision(peticion: PeticionPrevision): Promise<ResultadoPrevision> {
  const res = await apiFetch('/api/prevision-franjas/calcular', {
    method: 'POST',
    body: JSON.stringify(peticion),
    // Puede traer de Ágora muchos días de histórico en una sola llamada.
    timeoutMs: 120000,
  });
  if (!res.ok) throw new Error(await leerError(res, 'No se pudo calcular la previsión'));
  return res.json();
}

export async function listarEscenarios(): Promise<EscenarioPrevision[]> {
  const res = await apiFetch('/api/prevision-franjas/escenarios');
  if (!res.ok) throw new Error(await leerError(res, 'No se pudieron cargar los escenarios'));
  const data = await res.json();
  return Array.isArray(data.escenarios) ? data.escenarios : [];
}

export async function crearEscenario(datos: DatosEscenario): Promise<EscenarioPrevision> {
  const res = await apiFetch('/api/prevision-franjas/escenarios', {
    method: 'POST',
    body: JSON.stringify(datos),
  });
  if (!res.ok) throw new Error(await leerError(res, 'No se pudo guardar el escenario'));
  const data = await res.json();
  return data.escenario;
}

export async function actualizarEscenario(id: string, datos: DatosEscenario): Promise<EscenarioPrevision> {
  const res = await apiFetch('/api/prevision-franjas/escenarios', {
    method: 'PUT',
    body: JSON.stringify({ id, ...datos }),
  });
  if (!res.ok) throw new Error(await leerError(res, 'No se pudo actualizar el escenario'));
  const data = await res.json();
  return data.escenario;
}

export async function borrarEscenario(id: string, ambito: AmbitoEscenario): Promise<void> {
  const res = await apiFetch(
    `/api/prevision-franjas/escenarios?id=${encodeURIComponent(id)}&ambito=${encodeURIComponent(ambito)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(await leerError(res, 'No se pudo borrar el escenario'));
}

// ─── Utilidades de fecha y formato ───

/** Suma `n` días a una fecha ISO (YYYY-MM-DD) sin depender de la zona horaria. */
export function sumarDiasIso(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días ISO entre `desde` y `hasta` (inclusive). Vacío si el rango no es válido. */
export function diasEntreIso(desde: string, hasta: string, max = 366): string[] {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(desde) || !re.test(hasta) || desde > hasta) return [];
  const out: string[] = [];
  let cur = desde;
  while (cur <= hasta && out.length < max) {
    out.push(cur);
    cur = sumarDiasIso(cur, 1);
  }
  return out;
}

/** 0 = domingo … 6 = sábado. */
export function diaSemanaIso(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/** "2026-12-31" → "Jue 31/12". */
export function etiquetaDiaCorta(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${DIAS_CORTOS[diaSemanaIso(iso)]} ${d}/${m}`;
}

/** "2026-12-31" → "31/12/2026". */
export function fechaEs(iso: string): string {
  const p = String(iso ?? '').split('-');
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : String(iso ?? '');
}

/** Importe en € sin decimales: "3.120 €". */
export function formatEur(n: number): string {
  const v = Math.round(Number(n) || 0);
  const signo = v < 0 ? '-' : '';
  return `${signo}${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
}

/** Ratio → "+5,9 %". */
export function formatPct(ratio: number): string {
  const v = Math.round((Number(ratio) || 0) * 1000) / 10;
  const signo = v > 0 ? '+' : '';
  return `${signo}${v.toFixed(1).replace('.', ',')} %`;
}

// ─── Escala de color del mapa de calor ───

const COLOR_MIN: [number, number, number] = [0xf0, 0xf9, 0xff];
const COLOR_MAX: [number, number, number] = [0x03, 0x69, 0xa1];

/** Color RGB interpolado entre #f0f9ff y #0369a1 según `valor / max`. */
export function colorEscalaRgb(valor: number, max: number): [number, number, number] {
  const t = max > 0 ? Math.max(0, Math.min(1, valor / max)) : 0;
  return [0, 1, 2].map((i) => Math.round(COLOR_MIN[i] + (COLOR_MAX[i] - COLOR_MIN[i]) * t)) as [
    number,
    number,
    number,
  ];
}

export function rgbAHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Texto blanco si el fondo es oscuro (luminancia relativa aproximada). */
export function esFondoOscuro([r, g, b]: [number, number, number]): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}

/** Máximo importe previsto de una celda en los días válidos del local. */
export function maxCeldaLocal(local: LocalPrevision): number {
  let max = 0;
  for (const d of local.dias) {
    if (!d.valida) continue;
    for (const c of d.celdas) if (c.previsto > max) max = c.previsto;
  }
  return max;
}
