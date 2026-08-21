/**
 * Tipos de la conciliación bancaria: emparejar movimientos importados con
 * facturas pendientes.
 *
 * Copian el contrato de `api/routes/bancaConciliacion.js`.
 *
 * Cada importe llega por duplicado: en euros para pintarlo y en céntimos
 * enteros para calcular con él. **Toda comparación va en céntimos.** El criterio
 * de "cuadra exactamente" es una igualdad, y con decimales en coma flotante una
 * factura de 4,35 € dejaría de cuadrar consigo misma.
 */

/** Cómo encaja el movimiento con las facturas de la sugerencia. */
export type TipoSugerencia =
  /** El pendiente de la factura es exactamente el importe libre del movimiento. */
  | 'exacta'
  /** Cubre solo una parte: o se queda corto para la factura, o sobra movimiento. */
  | 'parcial'
  /** Varias facturas de la misma contraparte que suman el importe libre. */
  | 'combinacion';

/**
 * Cuánto fiarse. `alta` exige importe exacto más CIF o número de factura;
 * `media`, importe exacto más nombre parecido; el resto es `baja`.
 */
export type NivelConfianza = 'alta' | 'media' | 'baja';

export type EstadoConciliacionMovimiento =
  | 'pendiente'
  | 'parcial'
  | 'conciliado'
  /** El usuario ha dicho que no es una factura: comisión, traspaso, nómina. */
  | 'ignorado';

/** Qué señales han casado. Es lo que se le enseña al usuario para que decida. */
export type SenalesSugerencia = {
  numeroFactura?: boolean;
  /** El número que se encontró literalmente en el concepto del extracto. */
  referencia?: string;
  cif?: boolean;
  cifCoincidente?: string;
  importeExacto?: boolean;
  nombre?: boolean;
  tokensNombre?: string[];
  /** Días entre el movimiento y el vencimiento (negativo si el apunte es anterior). */
  dias?: number | null;
  /** El IBAN del movimiento no está de alta: no se pudo comprobar la sociedad. */
  sinEmpresa?: boolean;
};

/** Una factura dentro de una sugerencia, con lo que se le asignaría. */
export type FacturaSugerida = {
  id_factura: string;
  tipo?: string;
  estado?: string;
  numero?: string;
  serie?: string;
  emisor_id?: string;
  emisor_nombre?: string;
  empresa_nombre?: string;
  empresa_cif?: string;
  fecha_emision?: string;
  fecha_vencimiento?: string;
  saldoPendiente: number;
  saldoPendienteCentimos: number;
  asignado: number;
  asignadoCentimos: number;
  /** Lo que le quedaría pendiente a la factura después de conciliar. */
  restoFactura: number;
  restoFacturaCentimos: number;
  /** Aún sin validar: se puede conciliar, pero conviene avisar. */
  pendienteRevision?: boolean;
};

/**
 * El apunte bancario descrito, para el panel derecho del modal.
 *
 * Los nombres son los del ítem de `Igp_BankMovements` a propósito: así se le
 * puede pasar tal cual a `beneficiarioMovimiento` y `conceptoCortoMovimiento`
 * de `app/lib/banca.ts` en vez de duplicar ese criterio.
 */
export type MovimientoDeSugerencia = {
  concepto?: string;
  conceptoNormalizado?: string;
  nif?: string;
  referencia1?: string;
  referencia2?: string;
  numeroDocumento?: string;
  empresaId?: string;
  empresaNombre?: string;
  iban?: string;
  fechaValor?: string;
  formatoOrigen?: string;
  nombreFichero?: string;
  estadoConciliacion?: string;
};

export type SugerenciaConciliacion = {
  /** `movementHash:id+id`. Identifica la sugerencia para descartarla. */
  clave: string;
  tipo: TipoSugerencia;
  movementHash: string;
  cuentaRef: string;
  fechaOperacion: string;
  /** Del movimiento entero, con signo. */
  importe: number;
  importeCentimos: number;
  /** Lo que queda libre del movimiento (descontado lo ya conciliado). */
  conciliable: number;
  conciliableCentimos: number;
  asignado: number;
  asignadoCentimos: number;
  restoMovimiento: number;
  restoMovimientoCentimos: number;
  puntuacion: number;
  nivel: NivelConfianza;
  senales?: SenalesSugerencia;
  /** Explicación en español de por qué se propone, una frase por señal. */
  motivos?: string[];
  facturas: FacturaSugerida[];
  movimiento?: MovimientoDeSugerencia;
};

/** Sugerencias de un movimiento concreto, para la vista de banca. */
export type SugerenciasDeMovimiento = {
  movementHash: string;
  cuentaRef: string;
  fechaOperacion: string;
  concepto?: string;
  empresaId?: string;
  importe: number;
  importeCentimos: number;
  conciliable: number;
  conciliableCentimos: number;
  estadoConciliacion?: EstadoConciliacionMovimiento | string;
  /** Descartado por una regla de concepto (TPV, traspaso, comisión…). */
  excluido?: boolean;
  patronExclusion?: string;
  ignorado?: boolean;
  candidatas?: number;
  sugerencias: SugerenciaConciliacion[];
};

/**
 * Sugerencias agrupadas por factura. Es lo que consumen los listados de
 * facturas para decidir si pintan el icono y de qué color.
 */
export type SugerenciasDeFactura = {
  id_factura: string;
  mejorNivel: NivelConfianza;
  mejorPuntuacion: number;
  sugerencias: SugerenciaConciliacion[];
};

export type TotalesConciliacion = {
  movimientos: number;
  movimientosConSugerencias: number;
  movimientosExcluidos: number;
  facturasElegibles: number;
  sugerencias: number;
};

export type RespuestaSugerencias = {
  ok?: boolean;
  filtros?: {
    tipo?: string;
    empresaId?: string;
    desde?: string;
    hasta?: string;
    limite?: number;
  };
  porMovimiento?: SugerenciasDeMovimiento[];
  porFactura?: SugerenciasDeFactura[];
  totales?: TotalesConciliacion;
  error?: string;
};

/** Lo que se manda al confirmar: cuánto de este movimiento va a cada factura. */
export type AsignacionConciliacion = {
  id_factura: string;
  /** En euros, que es lo que espera el registro de pagos. */
  importe: number;
};

/** Estado del movimiento tras la operación, tal y como lo devuelve el backend. */
export type ResumenMovimientoConciliado = {
  movementHash: string;
  cuentaRef: string;
  fechaOperacion?: string;
  concepto?: string;
  importe: number;
  importeCentimos: number;
  estadoConciliacion: EstadoConciliacionMovimiento | string;
  conciliado: number;
  conciliadoCentimos: number;
  /** Lo que sigue sin asignar del movimiento. */
  libre: number;
  libreCentimos: number;
  conciliaciones?: Array<{
    id_factura?: string;
    id_pago?: string;
    importeCentimos?: number;
    fecha?: string;
    usuario?: string;
    creadoEn?: string;
  }>;
};

export type AsignacionAplicada = {
  id_factura: string;
  id_pago: string;
  importe: number;
  importeCentimos: number;
  /** Ya estaba aplicada de un intento anterior: no se ha creado un pago nuevo. */
  idempotente?: boolean;
  estadoFactura?: string;
  saldoPendiente?: number;
};

export type AsignacionFallida = {
  id_factura: string;
  code: string;
  status?: number;
  mensaje: string;
  /** Presente si falló por estar la factura en una remesa activa. */
  remesaActiva?: unknown;
};

export type AvisoConciliacion = {
  code:
    | 'FACTURA_PENDIENTE_REVISION'
    | 'ASIGNACION_YA_APLICADA'
    /**
     * Se ha repartido más de lo que trae el movimiento. Solo pasa resolviendo
     * una carrera: los pagos ya existen y no se pueden anular solos, así que el
     * apunte queda sobreasignado y hay que cuadrarlo desde banca.
     */
    | 'MOVIMIENTO_SOBREASIGNADO'
    | string;
  id_factura?: string;
  mensaje: string;
  /** Solo en `MOVIMIENTO_SOBREASIGNADO`: lo repartido de más. */
  excesoCentimos?: number;
  exceso?: number;
};

/**
 * Códigos de `POST /aplicar`. `PARCIAL` (207) es el importante: parte de las
 * facturas se pagaron y parte no —el caso real es una factura metida en una
 * remesa activa—, así que la pantalla no puede tratarlo ni como éxito ni como
 * error. Reintentar solo lo fallido es seguro: la clave de idempotencia impide
 * que lo ya aplicado se duplique.
 */
export type CodigoAplicar =
  | 'OK'
  | 'PARCIAL'
  | 'NADA_APLICADO'
  | 'VALIDACION'
  | 'MOVIMIENTO_NO_ENCONTRADO'
  | 'MOVIMIENTO_IGNORADO'
  /**
   * Los pagos se crearon, pero el movimiento no pudo anotarlos porque otra
   * persona lo escribió a la vez y se agotaron los reintentos. No se trata como
   * error —el dinero está aplicado— ni como éxito: el apunte queda descuadrado
   * y hay que cuadrarlo desde banca. Reenviar la petición NO lo arregla.
   */
  | 'CONFLICTO_MOVIMIENTO'
  | string;

export type RespuestaAplicar = {
  ok?: boolean;
  code?: CodigoAplicar;
  aplicadas?: AsignacionAplicada[];
  fallidas?: AsignacionFallida[];
  avisos?: AvisoConciliacion[];
  movimiento?: ResumenMovimientoConciliado;
  errores?: Array<{ code?: string; id_factura?: string; mensaje: string }>;
  error?: string;
  mensaje?: string;
};

export type RespuestaDeshacer = {
  ok?: boolean;
  code?: string;
  deshecha?: { id_factura: string; id_pago: string };
  factura?: unknown;
  movimiento?: ResumenMovimientoConciliado;
  error?: string;
  mensaje?: string;
};

export type RespuestaIgnorar = {
  ok?: boolean;
  code?: string;
  movimiento?: ResumenMovimientoConciliado;
  error?: string;
  mensaje?: string;
};

export type RespuestaDescartar = {
  ok?: boolean;
  code?: string;
  yaEstaba?: boolean;
  sugerenciasDescartadas?: string[];
  error?: string;
  mensaje?: string;
};
