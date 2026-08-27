import { FECHA_SIN_LIMITE, type Tarea } from '../types/tasks';

/** Fecha ISO que cae en el calendario, o `null` si no hay vencimiento real. */
export function fechaLimiteCalendario(fecha?: string | null): string | null {
  const iso = (fecha ?? '').trim();
  if (!iso || iso === FECHA_SIN_LIMITE || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return iso;
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

/** Lunes de la semana ISO que contiene `fechaIso`. */
export function lunesDeSemanaIso(fechaIso: string): string {
  const d = new Date(`${fechaIso}T12:00:00`);
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + offset);
  return toIso(d);
}

export function diasDeSemana(lunesIso: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysIso(lunesIso, i));
}

export function inicioMesIso(fechaIso: string): string {
  return `${fechaIso.slice(0, 7)}-01`;
}

export function addMonthsIso(fechaIso: string, months: number): string {
  const [y, m] = fechaIso.split('-').map(Number);
  return toIso(new Date(y, m - 1 + months, 1));
}

export function celdasCalendarioMes(anclaIso: string): { iso: string; delMes: boolean }[] {
  const inicio = inicioMesIso(anclaIso);
  const lunes = lunesDeSemanaIso(inicio);
  const y = Number(inicio.slice(0, 4));
  const mo = Number(inicio.slice(5, 7));
  const ultimo = new Date(y, mo, 0).getDate();
  const finMes = `${inicio.slice(0, 7)}-${String(ultimo).padStart(2, '0')}`;
  const domingoFin = addDaysIso(lunesDeSemanaIso(finMes), 6);
  const dias: { iso: string; delMes: boolean }[] = [];
  let cur = lunes;
  while (cur <= domingoFin) {
    dias.push({ iso: cur, delMes: cur.slice(0, 7) === inicio.slice(0, 7) });
    cur = addDaysIso(cur, 1);
  }
  return dias;
}

export function agruparPorFechaLimite(tareas: Tarea[]): Map<string, Tarea[]> {
  const map = new Map<string, Tarea[]>();
  for (const t of tareas) {
    const f = fechaLimiteCalendario(t.fecha_limite);
    if (!f) continue;
    const arr = map.get(f) ?? [];
    arr.push(t);
    map.set(f, arr);
  }
  return map;
}

export function tareasSinFecha(tareas: Tarea[]): Tarea[] {
  return tareas.filter((t) => !fechaLimiteCalendario(t.fecha_limite));
}

const DIAS_CORTO = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const DIAS_ULTRA = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_LARGO = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

function indiceLunes(iso: string): number {
  const dow = new Date(`${iso}T12:00:00`).getDay();
  return dow === 0 ? 6 : dow - 1;
}

export function weekdayShortEs(iso: string): string {
  return DIAS_CORTO[indiceLunes(iso)];
}

export function weekdayUltraEs(iso: string): string {
  return DIAS_ULTRA[indiceLunes(iso)];
}

export function weekdayHeaderEs(iso: string): string {
  return `${weekdayShortEs(iso).toUpperCase()} ${diaNumero(iso)}`;
}

export function diaNumero(iso: string): number {
  return Number(iso.slice(8, 10));
}

export function etiquetaSemana(lunesIso: string): string {
  const domingo = addDaysIso(lunesIso, 6);
  const fmt = (iso: string) => `${diaNumero(iso)} ${MESES_CORTO[Number(iso.slice(5, 7)) - 1]}`;
  return `${fmt(lunesIso)} – ${fmt(domingo)}`;
}

export function etiquetaMes(anclaIso: string): string {
  return `${MESES_LARGO[Number(anclaIso.slice(5, 7)) - 1]} ${anclaIso.slice(0, 4)}`;
}
