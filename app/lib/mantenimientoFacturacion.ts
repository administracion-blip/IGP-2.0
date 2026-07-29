/**
 * Facturación mensual de las reparaciones de mantenimiento (lado cliente).
 *
 * El contrato lo fija `api/lib/facturacion/facturarMantenimiento.js`:
 * - Periodo en formato AAAA-MM; por defecto se factura el mes anterior.
 * - Un parte facturado queda marcado con `factura_mantenimiento_id`, y desde ese
 *   momento el backend rechaza revalorarlo, cambiarle la fecha y borrarlo.
 * - Un parte que no puede facturarse (importe 0, o local de la propia sociedad
 *   emisora) se marca con `factura_mantenimiento_cierre` y **sin**
 *   `factura_mantenimiento_id`: no está facturado, simplemente deja de girar.
 *
 * El periodo y la agrupación de excluidos son comunes a todas las facturaciones
 * mensuales del grupo y viven en `facturacionPeriodica.ts`.
 */
import { labelPeriodoCorto, periodoAnterior, periodoValido } from './facturacionPeriodica';

export {
  desplazarPeriodo,
  labelPeriodo,
  labelPeriodoCorto,
  periodoDeFecha,
} from './facturacionPeriodica';

/** Alias del dominio: el periodo se valida igual en todas las facturaciones. */
export const periodoValidoMantenimiento = periodoValido;
/** Alias del dominio: por defecto se factura el mes anterior. */
export const periodoAnteriorMantenimiento = periodoAnterior;

/**
 * Textos de respaldo para los motivos de exclusión. El backend ya envía
 * `motivo_texto` en lenguaje claro; este mapa cubre respuestas antiguas o
 * motivos que se añadan sin texto.
 */
const MOTIVOS_EXCLUSION: Record<string, string> = {
  local_sin_empresa: 'El local no tiene sociedad asignada',
  empresa_inexistente: 'La sociedad del local ya no existe en el maestro de empresas',
  local_inexistente: 'El local del parte ya no existe en el maestro de locales',
  sociedad_sin_datos_fiscales: 'La sociedad no tiene los datos fiscales necesarios para facturarle',
  sociedad_es_emisora: 'La sede central no se factura a sí misma',
  parte_sin_lineas_facturables: 'Todas las líneas de la valoración tienen cantidad 0',
  factura_total_cero: 'La factura de la sociedad quedaría a 0 €',
  validacion_emision: 'La factura no pasaría la validación de emisión',
  concurrencia: 'El parte cambió mientras se generaba la factura',
};

/** Motivo en lenguaje claro: el texto del backend y, si falta, el de respaldo. */
export function textoMotivoExclusion(motivo?: string, motivoTexto?: string): string {
  const texto = String(motivoTexto ?? '').trim();
  if (texto) return texto;
  const clave = String(motivo ?? '').trim();
  return MOTIVOS_EXCLUSION[clave] ?? clave ?? 'Motivo no informado';
}

export type FacturaMantenimientoParte = {
  /** Identificador de la factura mensual en la que se cobró el parte. */
  idFactura: string;
  /** Periodo facturado (AAAA-MM); puede faltar en marcas antiguas. */
  periodo: string;
  /** ISO del momento en que se generó la factura. */
  fechaFacturacion: string;
  /** Sociedad a la que se le facturó el parte. */
  idEmpresa: string;
};

type ParteConMarca = {
  factura_mantenimiento_id?: unknown;
  factura_mantenimiento_periodo?: unknown;
  fecha_facturacion?: unknown;
  factura_mantenimiento_id_empresa?: unknown;
  factura_mantenimiento_cierre?: unknown;
  factura_mantenimiento_cierre_texto?: unknown;
  factura_mantenimiento_cierre_periodo?: unknown;
  factura_mantenimiento_cierre_en?: unknown;
};

/**
 * Marca de facturación del parte, o `null` si todavía no se ha facturado.
 * `factura_mantenimiento_id` es el único campo que decide: el resto es
 * información para el usuario y puede faltar.
 */
export function facturaMantenimientoDeParte(
  parte: ParteConMarca | null | undefined,
): FacturaMantenimientoParte | null {
  const idFactura = String(parte?.factura_mantenimiento_id ?? '').trim();
  if (!idFactura) return null;
  return {
    idFactura,
    periodo: String(parte?.factura_mantenimiento_periodo ?? '').trim(),
    fechaFacturacion: String(parte?.fecha_facturacion ?? '').trim(),
    idEmpresa: String(parte?.factura_mantenimiento_id_empresa ?? '').trim(),
  };
}

/** Atajo para condicionar acciones que el backend rechaza si el parte está facturado. */
export function parteFacturado(parte: ParteConMarca | null | undefined): boolean {
  return facturaMantenimientoDeParte(parte) !== null;
}

/** Motivos de cierre sin factura que escribe el proceso mensual. */
export const CIERRE_SIN_LINEAS_FACTURABLES = 'sin_lineas_facturables';
export const CIERRE_SOCIEDAD_EMISORA = 'sociedad_emisora';

/**
 * Explicación de cada motivo, escrita para el usuario del módulo. Se prefiere a
 * `factura_mantenimiento_cierre_texto`, que está redactado para el informe de la
 * generación; el texto del backend queda como respaldo para motivos nuevos.
 */
const TEXTOS_CIERRE: Record<string, string> = {
  [CIERRE_SIN_LINEAS_FACTURABLES]:
    'El desplazamiento de este parte ya se cobró completo en otro parte del mismo día, así que no queda ningún importe que facturar.',
  [CIERRE_SOCIEDAD_EMISORA]:
    'El local pertenece a la sociedad que emite las facturas de mantenimiento, y la sede central no se factura a sí misma.',
};

/** Motivo del cierre en lenguaje claro, nunca la clave técnica a secas. */
export function textoCierreSinFactura(motivo?: string, motivoTexto?: string): string {
  const clave = String(motivo ?? '').trim();
  const propio = TEXTOS_CIERRE[clave];
  if (propio) return propio;
  const texto = String(motivoTexto ?? '').trim();
  if (texto) return texto;
  return clave || 'Motivo no informado';
}

export type CierreSinFacturaParte = {
  /** Motivo en clave, tal como lo guarda el backend. */
  motivo: string;
  /** Motivo en lenguaje claro. */
  texto: string;
  /** Periodo (AAAA-MM) en cuya generación se cerró el parte. */
  periodo: string;
  /** ISO del momento del cierre. */
  fechaCierre: string;
};

/**
 * Cierre sin factura del parte, o `null` si no lo tiene. No es un estado
 * definitivo: el backend borra la marca en cuanto el importe del parte vuelve a
 * cambiar (por ejemplo, si el reparto de kilómetros se lo devuelve), y entonces
 * el parte vuelve a entrar en la facturación del mes.
 */
export function cierreSinFacturaDeParte(
  parte: ParteConMarca | null | undefined,
): CierreSinFacturaParte | null {
  // Un parte facturado no puede estar cerrado sin factura: el reclamo borra la
  // marca. Si llegaran las dos, manda la factura.
  if (parteFacturado(parte)) return null;
  const motivo = String(parte?.factura_mantenimiento_cierre ?? '').trim();
  if (!motivo) return null;
  return {
    motivo,
    texto: textoCierreSinFactura(motivo, String(parte?.factura_mantenimiento_cierre_texto ?? '')),
    periodo: String(parte?.factura_mantenimiento_cierre_periodo ?? '').trim(),
    fechaCierre: String(parte?.factura_mantenimiento_cierre_en ?? '').trim(),
  };
}

export type EstadoFacturacionParte = {
  estado: 'facturado' | 'sin_factura' | 'pendiente';
  /** Etiqueta corta para celdas de tabla y tarjetas. */
  texto: string;
  /** Explicación en lenguaje claro; vacía si no hay nada que explicar. */
  detalle: string;
};

/**
 * Los tres estados de facturación de un parte, con su etiqueta. Única fuente de
 * los textos de la columna «Facturación» y de las tarjetas equivalentes.
 */
export function estadoFacturacionParte(
  parte: ParteConMarca | null | undefined,
): EstadoFacturacionParte {
  const factura = facturaMantenimientoDeParte(parte);
  if (factura) {
    return {
      estado: 'facturado',
      texto: factura.periodo ? labelPeriodoCorto(factura.periodo) : 'Facturado',
      detalle: '',
    };
  }
  const cierre = cierreSinFacturaDeParte(parte);
  if (cierre) return { estado: 'sin_factura', texto: 'Sin factura', detalle: cierre.texto };
  return { estado: 'pendiente', texto: 'Pendiente', detalle: '' };
}
