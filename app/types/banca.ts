/**
 * Tipos del módulo Banca. Copian el contrato de `api/routes/banca.js`, así que
 * todos los campos que no forman parte de la clave del ítem se declaran
 * opcionales: los extractos vienen de bancos distintos y no todos los rellenan.
 */

export type FormatoExtracto = {
  clave: string;
  nombre: string;
  extensiones: string[];
  /** El fichero identifica la cuenta por sí mismo (Norma 43). */
  traeIban: boolean;
};

/** Línea del extracto que el lector no pudo interpretar (o que anotó como aviso). */
export type IncidenciaCarga = {
  linea?: number;
  tipo?: string;
  motivo?: string;
};

/** Lo que suman los movimientos no cuadra con lo que declara el banco. */
export type DescuadreCuenta = {
  campo: string;
  declarado: number | null;
  calculado: number;
};

export type CuentaCarga = {
  cuentaRef?: string;
  iban?: string;
  ccc?: string;
  ibanValido?: boolean;
  titular?: string;
  divisa?: string;
  empresaId?: string;
  empresaNombre?: string;
  /** El IBAN no está dado de alta como cuenta bancaria de ninguna empresa. */
  pendienteAsignar?: boolean;
  fechaDesde?: string;
  fechaHasta?: string;
  saldoInicial?: number;
  saldoFinal?: number | null;
  movimientos?: number;
  nuevos?: number;
  duplicados?: number;
  descuadres?: DescuadreCuenta[];
};

export type EstadoCarga = 'cargado' | 'pendiente_cuenta';

export type CargaExtracto = {
  hashFichero: string;
  nombreFichero?: string;
  formato?: string;
  codificacion?: string;
  estado?: EstadoCarga | string;
  s3Key?: string;
  tamanoBytes?: number;
  importadoEn?: string;
  importadoPor?: string;
  importadoConSolapamiento?: boolean;
  movimientosLeidos?: number;
  movimientosNuevos?: number;
  movimientosDuplicados?: number;
  lineasConError?: number;
  avisosTotal?: number;
  /** Recortadas a 100 por el backend; la bandera avisa de que hay más. */
  errores?: IncidenciaCarga[];
  erroresTruncados?: boolean;
  avisos?: IncidenciaCarga[];
  avisosTruncados?: boolean;
  cuentas?: CuentaCarga[];
};

export type MovimientoBanca = {
  movementHash: string;
  cuentaRef?: string;
  iban?: string;
  empresaId?: string;
  empresaNombre?: string;
  fechaOperacion?: string;
  fechaValor?: string;
  /** Con signo: cargo negativo, abono positivo. */
  importe?: number;
  importeCentimos?: number;
  signo?: 'D' | 'H' | string;
  concepto?: string;
  conceptoNormalizado?: string;
  nif?: string;
  referencia1?: string;
  referencia2?: string;
  numeroDocumento?: string;
  divisa?: string;
  ordinal?: number;
  estadoConciliacion?: string;
  hashFichero?: string;
  nombreFichero?: string;
  formatoOrigen?: string;
  lineaOrigen?: number;
  importadoEn?: string;
};

/** Carga anterior que ya tenía movimientos en el periodo del extracto nuevo. */
export type CargaSolapada = {
  hashFichero?: string;
  nombreFichero?: string;
  movimientos?: number;
};

export type Solapamiento = {
  cuentaRef?: string;
  iban?: string;
  desde?: string;
  hasta?: string;
  movimientosExistentes?: number;
  cargas?: CargaSolapada[];
};

/** Filtros de la consulta de movimientos (fechas en ISO `YYYY-MM-DD`). */
export type FiltrosMovimientos = {
  iban: string;
  empresaId: string;
  estado: string;
  desde: string;
  hasta: string;
};

/** Filtros del historial de cargas (rango sobre la fecha de importación). */
export type FiltrosCargas = {
  estado: string;
  iban: string;
  desde: string;
  hasta: string;
};
