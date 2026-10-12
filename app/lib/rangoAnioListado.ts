/** Años hacia atrás además del año en curso (selector de listados). */
export const ANIOS_ATRAS = 4;

/** Valor del selector que pide todo el histórico acotado que acepta la API. */
export const ANIO_TODOS = 'todos';

/**
 * Tope inferior de «Todos los años». El listado exige un rango cerrado
 * (`fechaDesde` / `fechaHasta` o `desde` / `hasta`), no un scan sin fechas.
 */
export const ANIO_MIN_HISTORICO = 2000;

const RE_ANIO = /^\d{4}$/;

export function anioEnCurso(): string {
  return String(new Date().getFullYear());
}

/** Año concreto del selector, o null si es «todos» u otro valor. */
export function anioConcreto(anioId: string): string | null {
  return RE_ANIO.test(anioId) ? anioId : null;
}

/** Rango ISO de un año, o del histórico completo si el id es `todos`. */
export function rangoIsoDeAnio(anioId: string): { desde: string; hasta: string } {
  if (anioId === ANIO_TODOS) {
    return { desde: `${ANIO_MIN_HISTORICO}-01-01`, hasta: `${anioEnCurso()}-12-31` };
  }
  const y = anioConcreto(anioId) ?? anioEnCurso();
  return { desde: `${y}-01-01`, hasta: `${y}-12-31` };
}

export type OpcionAnioListado = {
  id: string;
  titulo: string;
  icono: 'calendar-today';
};

/** Año en curso, los cuatro anteriores y, si cabe, «Todos los años». */
export function opcionesAnioListado(incluirTodos = false): OpcionAnioListado[] {
  const actual = new Date().getFullYear();
  const opciones: OpcionAnioListado[] = [];
  for (let i = 0; i <= ANIOS_ATRAS; i += 1) {
    const y = String(actual - i);
    opciones.push({ id: y, titulo: y, icono: 'calendar-today' });
  }
  if (incluirTodos) {
    opciones.push({ id: ANIO_TODOS, titulo: 'Todos los años', icono: 'calendar-today' });
  }
  return opciones;
}

export function urlPedidosPorAnio(anioId: string): string {
  const { desde, hasta } = rangoIsoDeAnio(anioId);
  const q = new URLSearchParams({ desde, hasta });
  return `/api/pedidos?${q.toString()}`;
}

export function urlFacturasPorAnio(tipo: 'IN' | 'OUT', anioId: string): string {
  const { desde, hasta } = rangoIsoDeAnio(anioId);
  const q = new URLSearchParams({ tipo, fechaDesde: desde, fechaHasta: hasta });
  return `/api/facturacion/facturas?${q.toString()}`;
}
