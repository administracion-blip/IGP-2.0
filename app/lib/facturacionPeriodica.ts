/**
 * Piezas comunes de las facturaciones mensuales del grupo, tanto la de
 * mantenimiento como la de ventas internas de compras (lado cliente).
 *
 * Las dos comparten contrato con el backend
 * (`api/lib/facturacion/facturacionPeriodica.js`): periodo en formato AAAA-MM,
 * por defecto el mes anterior, previsualización que no escribe nada y
 * generación que deja las facturas en borrador informando de todo lo que se
 * queda fuera con su motivo.
 *
 * Aquí vive solo lo que no depende del dominio: el periodo y la agrupación de
 * los excluidos. Los motivos, los textos y las marcas de cada elemento viven en
 * `mantenimientoFacturacion.ts` y `comprasFacturacion.ts`.
 */

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const MESES_CORTO = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

export function periodoValido(periodo: string): boolean {
  const s = String(periodo ?? '').trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return false;
  const mes = Number(s.slice(5, 7));
  return mes >= 1 && mes <= 12;
}

/** Periodo (AAAA-MM) natural de una fecha. */
export function periodoDeFecha(fecha = new Date()): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

/** Periodo del mes anterior: el que se factura por defecto. */
export function periodoAnterior(fecha = new Date()): string {
  return desplazarPeriodo(periodoDeFecha(fecha), -1);
}

/** Suma (o resta) meses a un periodo AAAA-MM. */
export function desplazarPeriodo(periodo: string, meses: number): string {
  if (!periodoValido(periodo)) return periodo;
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  const total = anio * 12 + (mes - 1) + meses;
  const anioNuevo = Math.floor(total / 12);
  const mesNuevo = (total % 12) + 1;
  return `${anioNuevo}-${String(mesNuevo).padStart(2, '0')}`;
}

/** «junio de 2026». */
export function labelPeriodo(periodo: string): string {
  if (!periodoValido(periodo)) return periodo;
  const mes = MESES[Number(periodo.slice(5, 7)) - 1] ?? '';
  return `${mes} de ${periodo.slice(0, 4)}`;
}

/** «jun 2026», para celdas de tabla y badges. */
export function labelPeriodoCorto(periodo: string): string {
  if (!periodoValido(periodo)) return periodo;
  const mes = MESES_CORTO[Number(periodo.slice(5, 7)) - 1] ?? '';
  return `${mes} ${periodo.slice(0, 4)}`;
}

/** Número finito o 0: los importes y contadores del backend pueden faltar. */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function plural(n: number, singular: string, plural_: string): string {
  return n === 1 ? singular : plural_;
}

/** Elemento que se queda fuera de la facturación, ya redactado para la pantalla. */
export type ItemExcluido = {
  /** Quién queda fuera: la sociedad, el local o el elemento concreto. */
  etiqueta: string;
  /** Aclaración del backend (qué dato falta exactamente). */
  detalle?: string;
  /** Cuántos elementos arrastra («3 pedidos»); vacío si no aporta nada. */
  recuento?: string;
};

export type GrupoExcluidos = {
  /** Clave técnica del motivo, que es lo que agrupa. */
  motivo: string;
  /** Motivo en lenguaje claro. */
  texto: string;
  items: ItemExcluido[];
};

/**
 * Agrupa los excluidos por motivo: el mismo texto repetido N veces no se lee.
 * El orden de aparición del primer elemento de cada motivo se conserva, que es
 * el que trae el backend.
 */
export function agruparPorMotivo<T>(
  excluidos: T[],
  fns: {
    motivo: (e: T) => string;
    texto: (e: T) => string;
    item: (e: T) => ItemExcluido;
  },
): GrupoExcluidos[] {
  const grupos = new Map<string, GrupoExcluidos>();
  for (const ex of excluidos) {
    const clave = fns.motivo(ex) || 'otro';
    const grupo: GrupoExcluidos =
      grupos.get(clave) ?? { motivo: clave, texto: fns.texto(ex), items: [] };
    grupo.items.push(fns.item(ex));
    grupos.set(clave, grupo);
  }
  return [...grupos.values()];
}

/** Total de elementos de una lista de grupos, para el contador del título. */
export function totalExcluidos(grupos: GrupoExcluidos[]): number {
  return grupos.reduce((s, g) => s + g.items.length, 0);
}
