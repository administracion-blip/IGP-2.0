/**
 * Filtros de los listados de facturas, guardados en la sesión.
 * Al abrir la ficha o el maestro de empresas la pantalla se vuelve a montar
 * y, sin esto, los filtros vuelven a su valor inicial.
 */

export type FiltrosListadoGasto = {
  tab: string;
  busqueda: string;
  fechaDesde: string;
  fechaHasta: string;
  empresasIds: string[];
  etiquetas: string[];
  anio: string;
  cola: string;
  proveedor: string;
  soloVenceEsteMes: boolean;
  soloDuplicados: boolean;
  soloConciliacion: boolean;
  soloExceso: boolean;
  sortCol: string;
  sortDir: 'asc' | 'desc';
};

export type FiltrosListadoVenta = {
  tab: string;
  busqueda: string;
  fechaDesde: string;
  fechaHasta: string;
  emisoresIds: string[];
  receptoresIds: string[];
  anio: string;
  sortCol: string;
  sortDir: 'asc' | 'desc';
};

const MEMORIA = new Map<string, unknown>();

function clave(tipo: 'IN' | 'OUT'): string {
  return `igp.filtrosFacturas.${tipo}`;
}

function leerRaw(key: string): unknown {
  const enMemoria = MEMORIA.get(key);
  if (enMemoria != null) return enMemoria;
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function guardarRaw(key: string, valor: unknown) {
  MEMORIA.set(key, valor);
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(key, JSON.stringify(valor));
    }
  } catch {
    /* cuota llena o navegador en modo privado */
  }
}

function texto(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function ids(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 80);
}

function fecha(v: unknown): string {
  const s = texto(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function dir(v: unknown): 'asc' | 'desc' {
  return v === 'asc' ? 'asc' : 'desc';
}

export function leerFiltrosGasto(): FiltrosListadoGasto | null {
  const v = leerRaw(clave('IN'));
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    tab: texto(o.tab, 40),
    busqueda: texto(o.busqueda),
    fechaDesde: fecha(o.fechaDesde),
    fechaHasta: fecha(o.fechaHasta),
    empresasIds: ids(o.empresasIds),
    etiquetas: ids(o.etiquetas),
    anio: texto(o.anio, 8),
    cola: texto(o.cola, 40),
    proveedor: texto(o.proveedor),
    soloVenceEsteMes: o.soloVenceEsteMes === true,
    soloDuplicados: o.soloDuplicados === true,
    soloConciliacion: o.soloConciliacion === true,
    soloExceso: o.soloExceso === true,
    sortCol: texto(o.sortCol, 40) || 'fecha_emision',
    sortDir: dir(o.sortDir),
  };
}

export function guardarFiltrosGasto(f: FiltrosListadoGasto) {
  guardarRaw(clave('IN'), f);
}

export function leerFiltrosVenta(): FiltrosListadoVenta | null {
  const v = leerRaw(clave('OUT'));
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return {
    tab: texto(o.tab, 40),
    busqueda: texto(o.busqueda),
    fechaDesde: fecha(o.fechaDesde),
    fechaHasta: fecha(o.fechaHasta),
    emisoresIds: ids(o.emisoresIds),
    receptoresIds: ids(o.receptoresIds),
    anio: texto(o.anio, 8),
    sortCol: texto(o.sortCol, 40) || 'fecha_emision',
    sortDir: dir(o.sortDir),
  };
}

export function guardarFiltrosVenta(f: FiltrosListadoVenta) {
  guardarRaw(clave('OUT'), f);
}

/** Año del selector, o el año en curso si lo guardado no es válido. */
export function anioFiltroGuardado(raw: string, anioActual: string): string {
  if (raw === 'todos' || /^\d{4}$/.test(raw)) return raw;
  return anioActual;
}
