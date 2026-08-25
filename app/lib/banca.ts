/**
 * Lógica de apoyo del módulo Banca: construcción de queries, textos de error de
 * la importación y formateo de los datos del extracto.
 *
 * Se mantiene aparte de la pantalla porque el modal de importación y el listado
 * de movimientos comparten casi todo (formatos, extensiones, etiquetas).
 */

import { limpiarIban } from './iban';
import { formatMoneda } from '../utils/facturacion';
import type {
  DescuadreCuenta,
  FiltrosCargas,
  FiltrosMovimientos,
  FormatoExtracto,
  MovimientoBanca,
} from '../types/banca';

/**
 * Entidades españolas por código (posiciones 5–8 del IBAN ES). Misma lista que
 * `api/lib/dynamo/bankAccounts.js`: si crece allí, actualizar aquí.
 */
const ENTIDADES_ES: Record<string, string> = {
  '0019': 'Deutsche Bank',
  '0030': 'Banesto',
  '0049': 'Santander',
  '0237': 'Cajasur',
  '0487': 'BMN',
  '3023': 'Caja Rural Granada',
  '0075': 'Popular',
  '0081': 'Sabadell',
  '0073': 'Openbank',
  '0128': 'Bankinter',
  '0182': 'BBVA',
  '0186': 'Mediolanum',
  '0234': 'Banco Caminos',
  '0239': 'EVO',
  '0061': 'Banca March',
  '1465': 'ING',
  '1491': 'Triodos',
  '2100': 'CaixaBank',
  '2038': 'Bankia',
  '2080': 'Abanca',
  '2085': 'Ibercaja',
  '2095': 'Kutxabank',
  '2103': 'Unicaja',
  '3058': 'Cajamar',
  '3025': "Caixa Enginyers",
  '3081': 'Eurocaja Rural',
  '3183': 'Arquia',
  '3187': 'Caja Rural Aragón',
};

/** Banco de la cuenta del movimiento, deducido del IBAN (sin ir al maestro). */
export function bancoDesdeIban(iban: string | undefined): { codigo: string; nombre: string } {
  const norm = limpiarIban(iban || '');
  if (!norm.startsWith('ES') || norm.length < 8) return { codigo: '', nombre: '' };
  const codigo = norm.slice(4, 8);
  if (!/^\d{4}$/.test(codigo)) return { codigo: '', nombre: '' };
  return { codigo, nombre: ENTIDADES_ES[codigo] || '' };
}

/** Etiqueta corta para la columna Banco. */
export function etiquetaBancoMovimiento(movimiento: MovimientoBanca): string {
  const { nombre, codigo } = bancoDesdeIban(movimiento.iban || movimiento.cuentaRef);
  if (nombre) return nombre;
  if (codigo) return `Entidad ${codigo}`;
  return '—';
}

/** Colores del badge de banco en la tabla de movimientos. */
export function estiloBadgeBanco(nombreBanco: string): { fondo: string; texto: string; borde: string } {
  const n = String(nombreBanco || '').toUpperCase();
  if (n.includes('BBVA')) return { fondo: '#eff6ff', texto: '#1d4ed8', borde: '#bfdbfe' };
  if (n.includes('SANTANDER')) return { fondo: '#fef2f2', texto: '#b91c1c', borde: '#fecaca' };
  if (n.includes('CAIXA') || n.includes('CAIXABANK')) return { fondo: '#fff7ed', texto: '#c2410c', borde: '#fed7aa' };
  if (n.includes('SABADELL')) return { fondo: '#ecfdf5', texto: '#047857', borde: '#a7f3d0' };
  if (n.includes('BANKINTER')) return { fondo: '#f5f3ff', texto: '#6d28d9', borde: '#ddd6fe' };
  if (n.includes('ING')) return { fondo: '#fff7ed', texto: '#ea580c', borde: '#fdba74' };
  if (n.includes('UNICAJA') || n.includes('ABANCA') || n.includes('KUTXA') || n.includes('IBERCAJA') || n.includes('CAJAMAR')) {
    return { fondo: '#f0fdf4', texto: '#166534', borde: '#bbf7d0' };
  }
  if (nombreBanco === '—' || !nombreBanco) return { fondo: '#f1f5f9', texto: '#64748b', borde: '#e2e8f0' };
  return { fondo: '#f8fafc', texto: '#334155', borde: '#cbd5e1' };
}

/**
 * Rango de fechas de operación cubierto por una carga (`dd/mm/aaaa – dd/mm/aaaa`).
 * Agrega el mínimo `fechaDesde` y el máximo `fechaHasta` de las cuentas del fichero.
 */
export function periodoCarga(
  carga: { cuentas?: Array<{ fechaDesde?: string; fechaHasta?: string }> },
  formatearFecha: (iso: string) => string,
): string {
  let desde = '';
  let hasta = '';
  for (const c of carga?.cuentas || []) {
    const d = String(c?.fechaDesde || '').trim();
    const h = String(c?.fechaHasta || '').trim();
    if (d && (!desde || d < desde)) desde = d;
    if (h && (!hasta || h > hasta)) hasta = h;
  }
  if (!desde && !hasta) return '—';
  if (desde && hasta && desde === hasta) return formatearFecha(desde);
  if (desde && hasta) return `${formatearFecha(desde)} – ${formatearFecha(hasta)}`;
  return formatearFecha(desde || hasta);
}

/** El Excel de BBVA/Caixa sí trae beneficiario/ordenante en `referencia1`; el Norma 43 no. */
export function esFormatoExcelConBeneficiario(formato: string | undefined): boolean {
  const f = String(formato || '').trim().toUpperCase();
  return f === 'BBVA_XLSX' || f === 'CAIXA_XLSX';
}

/** @deprecated Usar `esFormatoExcelConBeneficiario`. */
export function esFormatoExcelBbva(formato: string | undefined): boolean {
  return String(formato || '').trim().toUpperCase() === 'BBVA_XLSX';
}

/**
 * Contraparte (beneficiario / ordenante) para la tabla.
 * - Excel BBVA/Caixa: columna de contraparte → `referencia1`.
 * - Norma 43: `referencia1` es solo una referencia bancaria truncada; lo útil
 *   es `conceptoNormalizado` (concepto sin prefijos TRANSF/ADEUDO/PAGO…).
 */
export function beneficiarioMovimiento(movimiento: MovimientoBanca): string {
  if (esFormatoExcelConBeneficiario(movimiento.formatoOrigen)) {
    const ref = String(movimiento.referencia1 || '').trim();
    if (ref && !/^\*+$/.test(ref)) return ref;
    return '';
  }
  return String(movimiento.conceptoNormalizado || '').trim();
}

/**
 * Concepto legible en la tabla.
 * En Excel BBVA/Caixa el concepto llega concatenado con la contraparte: se
 * recorta para no repetir la columna Beneficiario. En Norma 43 se deja el
 * texto completo del banco.
 */
export function conceptoCortoMovimiento(movimiento: MovimientoBanca): string {
  const completo = String(movimiento.concepto || movimiento.conceptoNormalizado || '').trim();
  if (!completo) return '—';
  if (!esFormatoExcelConBeneficiario(movimiento.formatoOrigen)) return completo;

  let limpio = completo;
  for (const trozo of [movimiento.referencia1, movimiento.referencia2]) {
    const t = String(trozo || '').trim();
    if (!t || /^\*+$/.test(t)) continue;
    limpio = limpio.replace(t, ' ');
  }
  limpio = limpio.replace(/\s{2,}/g, ' ').trim();
  return limpio || completo;
}

/** Único estado de conciliación que escribe la importación. */
export const ESTADO_CONCILIACION_PENDIENTE = 'pendiente';

/** Movimientos por página. El backend admite hasta 1000. */
export const LIMITE_MOVIMIENTOS = 200;

/** Cargas que se piden al historial. */
export const LIMITE_CARGAS = 200;

/**
 * Extensiones que se ofrecen mientras `/api/banca/formatos` no ha respondido.
 * La lista real la manda el backend: esto solo evita un selector vacío.
 */
const EXTENSIONES_FALLBACK = ['.q43', '.n43', '.043', '.txt', '.dat', '.xlsx'];

/** Extensión en minúsculas (con punto) de un nombre de fichero. */
export function extensionDe(nombreFichero: string): string {
  const coincidencia = /\.[^./\\]+$/.exec(String(nombreFichero || '').trim().toLowerCase());
  return coincidencia ? coincidencia[0] : '';
}

/** Extensiones aceptadas: la unión de las que declara cada formato del backend. */
export function extensionesAceptadas(formatos: FormatoExtracto[]): string[] {
  const unicas = new Set<string>();
  for (const formato of formatos) {
    for (const ext of formato.extensiones || []) {
      const limpia = String(ext || '').trim().toLowerCase();
      if (!limpia) continue;
      unicas.add(limpia.startsWith('.') ? limpia : `.${limpia}`);
    }
  }
  return unicas.size > 0 ? [...unicas] : [...EXTENSIONES_FALLBACK];
}

export function aceptaExtracto(nombreFichero: string, extensiones: string[]): boolean {
  const ext = extensionDe(nombreFichero);
  return Boolean(ext) && extensiones.includes(ext);
}

/** Nombre del formato para mostrar; si no está en el catálogo, la clave cruda. */
export function nombreFormato(clave: string | undefined, formatos: FormatoExtracto[]): string {
  const c = String(clave || '').trim();
  if (!c) return '—';
  return formatos.find((f) => f.clave === c)?.nombre ?? c;
}

/** La consulta de movimientos exige al menos uno de estos tres filtros. */
export function hayFiltroMovimientos(filtros: Pick<FiltrosMovimientos, 'iban' | 'empresaId' | 'estado'>): boolean {
  return Boolean(filtros.iban.trim() || filtros.empresaId.trim() || filtros.estado.trim());
}

/** Orden de la página de movimientos por fecha de operación. */
export type OrdenMovimientos = 'asc' | 'desc';

/**
 * Query de `/api/banca/movimientos`.
 *
 * El backend resuelve por cuenta, por empresa o por estado en ese orden, así que
 * con una cuenta elegida no se manda `empresaId`: se ignoraría y solo
 * confundiría al leer los filtros que devuelve la respuesta.
 *
 * `orden` es opcional a propósito: si no se indica no se manda el parámetro y el
 * backend aplica su `desc` de siempre (lo más reciente primero). Solo el panel
 * de conciliación desde la factura pide `asc`, porque el apunte que busca está
 * al principio del rango.
 */
export function queryMovimientos(
  filtros: FiltrosMovimientos,
  cursor = '',
  opciones: { orden?: OrdenMovimientos } = {},
): string {
  const params = new URLSearchParams();
  const iban = filtros.iban.trim();
  const empresaId = filtros.empresaId.trim();
  if (iban) params.set('iban', iban);
  else if (empresaId) params.set('empresaId', empresaId);
  if (filtros.estado.trim()) params.set('estado', filtros.estado.trim());
  if (filtros.desde) params.set('desde', filtros.desde);
  if (filtros.hasta) params.set('hasta', filtros.hasta);
  params.set('limite', String(LIMITE_MOVIMIENTOS));
  if (cursor) params.set('cursor', cursor);
  if (opciones.orden) params.set('orden', opciones.orden);
  return `/api/banca/movimientos?${params.toString()}`;
}

/** Query de `/api/banca/ficheros` (el rango filtra por fecha de importación). */
export function queryCargas(filtros: FiltrosCargas): string {
  const params = new URLSearchParams();
  if (filtros.estado.trim()) params.set('estado', filtros.estado.trim());
  if (filtros.iban.trim()) params.set('iban', filtros.iban.trim());
  if (filtros.desde) params.set('desde', filtros.desde);
  if (filtros.hasta) params.set('hasta', filtros.hasta);
  params.set('limite', String(LIMITE_CARGAS));
  return `/api/banca/ficheros?${params.toString()}`;
}

/** Alta de cuenta bancaria desde una carga con IBAN pendiente de asignar. */
export function urlAsignarCuentaCarga(hashFichero: string): string {
  return `/api/banca/ficheros/${encodeURIComponent(hashFichero)}/asignar-cuenta`;
}

export function etiquetaEstadoCarga(estado: string | undefined): string {
  const e = String(estado || '').trim();
  if (e === 'cargado') return 'Cargado';
  if (e === 'pendiente_cuenta') return 'Cuenta sin asignar';
  // Una carga se queda así si la importación se cortó a mitad: vuelve a subir el
  // mismo fichero y se reanuda desde donde estaba.
  if (e === 'en_curso') return 'Incompleta';
  return e || '—';
}

/** Mensaje de error de la importación, según el `code` que devuelve el backend. */
export function textoErrorImportacion(
  code: string | undefined,
  error: string | undefined,
  ibanesFichero?: string[],
): { titulo: string; mensaje: string } {
  const detalle = String(error || '').trim();
  switch (String(code || '')) {
    case 'FORMATO_NO_SOPORTADO':
      return {
        titulo: 'Formato de extracto no soportado',
        mensaje:
          detalle
          || 'Todavía no se leen extractos de este tipo. Descarga del banco el fichero Norma 43 (.q43) o el Excel de BBVA (.xlsx).',
      };
    case 'FORMATO_DESCONOCIDO':
      return {
        titulo: 'Formato desconocido',
        mensaje: detalle || 'El formato indicado no existe. Deja que se detecte por la extensión del fichero.',
      };
    case 'IBAN_REQUERIDO':
      return {
        titulo: 'Falta el IBAN de la cuenta',
        mensaje:
          detalle
          || 'Este formato de extracto no identifica la cuenta: escribe el IBAN al que corresponden los movimientos.',
      };
    case 'IBAN_NO_COINCIDE': {
      const encontrados = (ibanesFichero || []).filter(Boolean).join(', ');
      return {
        titulo: 'El extracto es de otra cuenta',
        mensaje: encontrados
          ? `El fichero contiene movimientos de ${encontrados}, que no es el IBAN indicado. Comprueba que has descargado el extracto de la cuenta correcta.`
          : detalle || 'El IBAN indicado no coincide con el del fichero.',
      };
    }
    default:
      return {
        titulo: 'No se ha podido importar el extracto',
        mensaje: detalle || 'Revisa el fichero e inténtalo de nuevo.',
      };
  }
}

const ETIQUETAS_DESCUADRE: Record<string, string> = {
  numeroApuntesDebe: 'Número de apuntes al debe',
  totalDebe: 'Total al debe',
  numeroApuntesHaber: 'Número de apuntes al haber',
  totalHaber: 'Total al haber',
  saldoFinal: 'Saldo final',
};

/** Campos del descuadre que son contadores de apuntes, no importes. */
const DESCUADRES_CONTADOR = new Set(['numeroApuntesDebe', 'numeroApuntesHaber']);

export function etiquetaDescuadre(campo: string): string {
  return ETIQUETAS_DESCUADRE[campo] ?? campo;
}

export function valorDescuadre(descuadre: DescuadreCuenta, cual: 'declarado' | 'calculado'): string {
  const valor = cual === 'declarado' ? descuadre.declarado : descuadre.calculado;
  if (valor == null) return '—';
  if (DESCUADRES_CONTADOR.has(descuadre.campo)) return String(valor);
  return formatMoneda(Number(valor) || 0);
}

/** `ES1234…` → `ES12 3456 …`: un IBAN se lee agrupado de cuatro en cuatro. */
export function ibanLegible(iban: string | undefined): string {
  const limpio = String(iban || '').replace(/[\s-]/g, '').toUpperCase();
  if (!limpio) return '—';
  return limpio.replace(/(.{4})/g, '$1 ').trim();
}

export function tamanoLegible(bytes: number | undefined): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Importe con signo del movimiento (el backend ya manda el cargo en negativo). */
export function importeMovimiento(movimiento: MovimientoBanca): number {
  const importe = Number(movimiento.importe) || 0;
  if (importe !== 0) return importe;
  const centimos = Number(movimiento.importeCentimos) || 0;
  return centimos / 100;
}

export function esCargo(movimiento: MovimientoBanca): boolean {
  if (movimiento.signo === 'D') return true;
  if (movimiento.signo === 'H') return false;
  return importeMovimiento(movimiento) < 0;
}

/** Totales de lo que hay cargado en pantalla (no del total de la cuenta). */
export function totalesMovimientos(movimientos: MovimientoBanca[]): {
  cargos: number;
  abonos: number;
  neto: number;
} {
  let cargos = 0;
  let abonos = 0;
  for (const movimiento of movimientos) {
    const importe = importeMovimiento(movimiento);
    if (esCargo(movimiento)) cargos += Math.abs(importe);
    else abonos += Math.abs(importe);
  }
  return { cargos, abonos, neto: abonos - cargos };
}

/** Texto de una línea de movimiento para la búsqueda libre de la tabla. */
export function textoBusquedaMovimiento(movimiento: MovimientoBanca): string {
  return [
    movimiento.concepto,
    movimiento.conceptoNormalizado,
    etiquetaBancoMovimiento(movimiento),
    beneficiarioMovimiento(movimiento),
    movimiento.empresaNombre,
    movimiento.iban,
    movimiento.referencia1,
    movimiento.referencia2,
    movimiento.numeroDocumento,
    movimiento.nif,
    movimiento.nombreFichero,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
