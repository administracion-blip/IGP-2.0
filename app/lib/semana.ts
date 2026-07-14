/** Lunes de la semana que contiene `fecha` (calendario ISO, semana empieza en lunes). */
export function inicioSemanaLunes(fecha: Date): Date {
  const d = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function isoDesdeDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function rangoSemanaDesde(fechaInicioSemana: Date): { desde: string; hasta: string; dias: string[] } {
  const inicio = new Date(fechaInicioSemana.getFullYear(), fechaInicioSemana.getMonth(), fechaInicioSemana.getDate());
  const dias: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(inicio);
    d.setDate(inicio.getDate() + i);
    dias.push(isoDesdeDate(d));
  }
  return { desde: dias[0], hasta: dias[6], dias };
}

export function etiquetaSemana(desde: string, hasta: string): string {
  const parse = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return { y: parseInt(m[1], 10), m: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  };
  const a = parse(desde);
  const b = parse(hasta);
  if (!a || !b) return `${desde} – ${hasta}`;
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  if (a.y === b.y && a.m === b.m) {
    return `${a.d} – ${b.d} ${meses[a.m - 1]} ${a.y}`;
  }
  if (a.y === b.y) {
    return `${a.d} ${meses[a.m - 1]} – ${b.d} ${meses[b.m - 1]} ${a.y}`;
  }
  return `${a.d} ${meses[a.m - 1]} ${a.y} – ${b.d} ${meses[b.m - 1]} ${b.y}`;
}

export const ETIQUETAS_DIA_CORTO = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export type PresetSemana = 'anterior' | 'esta' | 'proxima' | 'custom';

/** ISO yyyy-mm-dd → Date local (sin desfase horario). */
function isoADate(iso: string): Date {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date();
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

/** Rango lunes→domingo de la semana desplazada `offsetSemanas` respecto a `hoyIso`. */
export function rangoSemana(hoyIso: string, offsetSemanas = 0): { from: string; to: string } {
  const base = inicioSemanaLunes(isoADate(hoyIso));
  base.setDate(base.getDate() + offsetSemanas * 7);
  const { desde, hasta } = rangoSemanaDesde(base);
  return { from: desde, to: hasta };
}

/** ¿[from,to] coincide con la semana anterior/actual/próxima? Si no, 'custom'. */
export function detectarPresetSemana(hoyIso: string, from: string, to: string): PresetSemana {
  const presets: [Exclude<PresetSemana, 'custom'>, number][] = [
    ['anterior', -1],
    ['esta', 0],
    ['proxima', 1],
  ];
  for (const [preset, offset] of presets) {
    const r = rangoSemana(hoyIso, offset);
    if (r.from === from && r.to === to) return preset;
  }
  return 'custom';
}
