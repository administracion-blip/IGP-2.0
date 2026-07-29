/**
 * Escenario común de las pruebas de facturación: monta el doble de DynamoDB con
 * todas las tablas que tocan los generadores y lo enchufa al cliente real.
 *
 * Las variables de entorno se fijan **antes** de importar `lib/db.js`, porque
 * ese módulo resuelve los nombres de tabla al evaluarse: si se importara antes,
 * las pruebas escribirían contra los nombres de producción.
 */

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, client, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');

/** Esquemas de clave reales de cada tabla implicada. */
const ESQUEMAS = [
  [tables.pedidos, { hashKey: 'Id' }],
  [tables.pedidosLineas, { hashKey: 'PedidoId', rangeKey: 'LineaIndex' }],
  [tables.locales, { hashKey: 'id_Locales' }],
  [tables.empresas, { hashKey: 'id_empresa' }],
  [tables.almacenes, { hashKey: 'Id' }],
  [tables.agoraProducts, { hashKey: 'PK', rangeKey: 'SK' }],
  [tables.mantenimiento, { hashKey: 'PK', rangeKey: 'SK' }],
  [tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' }],
  [tables.facturas, { hashKey: 'id_factura' }],
  [tables.facturasLineas, { hashKey: 'id_factura', rangeKey: 'id_linea' }],
  [tables.facturasSeries, { hashKey: 'serie' }],
  [tables.facturasAuditoria, { hashKey: 'id_entrada' }],
];

/**
 * @param {{ paginaTam?: number }} opciones Con `paginaTam` las lecturas paginan,
 *   que es como se comprueba que los bucles `do/while` recogen todas las páginas.
 */
export function montarEscenario({ paginaTam = 2 } = {}) {
  const db = crearDynamoMemoria({ paginaTam });
  for (const [nombre, esquema] of ESQUEMAS) db.crearTabla(nombre, esquema);
  db.instalar(docClient, client);
  return db;
}

export { tables };

// ─── Periodos ───

/**
 * Los periodos de las pruebas son **relativos a hoy**, no fechas fijas.
 *
 * Solo se pueden facturar periodos cerrados, así que un periodo escrito a mano
 * ('2026-07') pasaba a ser el mes en curso durante ese mes y la prueba fallaba
 * un mes al año. `PERIODO` es el antepenúltimo mes para que `PERIODO_SIGUIENTE`
 * también esté cerrado: hay pruebas que necesitan dos periodos facturables
 * consecutivos.
 */
function periodoHace(meses) {
  const hoy = new Date();
  const d = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth() - meses, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const PERIODO_ANTERIOR = periodoHace(3);
export const PERIODO = periodoHace(2);
export const PERIODO_SIGUIENTE = periodoHace(1);
export const PERIODO_EN_CURSO = periodoHace(0);

/** Día del periodo en formato ISO corto: `dia(PERIODO, 12)` → '2026-05-12'. */
export function dia(periodo, dd) {
  return `${periodo}-${String(dd).padStart(2, '0')}`;
}

/** Instante ISO completo dentro del periodo, que es el formato de `CompletadoEn`. */
export function instante(periodo, dd, hora = '10:00:00') {
  return `${dia(periodo, dd)}T${hora}.000Z`;
}

/** Último día del periodo: la fecha de emisión y de operación de estos documentos. */
export function ultimoDia(periodo) {
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  return dia(periodo, new Date(Date.UTC(anio, mes, 0)).getUTCDate());
}

// ─── Datos de referencia ───

export const EMPRESA_CENTRAL = '000001';
export const EMPRESA_NORTE = '000002';
export const EMPRESA_SUR = '000003';

/** Sociedad con datos fiscales completos: la que sale bien en las pruebas. */
export function empresa(id, nombre, extra = {}) {
  return {
    id_empresa: id,
    nombre,
    cif: `B${id}000`,
    Direccion: `Calle ${nombre} 1`,
    Cp: '28001',
    Municipio: 'Madrid',
    Provincia: 'Madrid',
    Email: `${nombre.toLowerCase()}@grupo.test`,
    ...extra,
  };
}

export function local(id, nombre, idEmpresa, almacenes = []) {
  return {
    id_Locales: id,
    nombre,
    id_empresa: idEmpresa,
    'almacen origen': almacenes.join(', '),
  };
}

export function almacen(id, nombre) {
  return { Id: id, Nombre: nombre };
}

export function producto(id, iva) {
  return { PK: 'GLOBAL', SK: id, ultimo_iva_compra: iva };
}

export function pedido(id, campos = {}) {
  return {
    Id: id,
    Estado: 'Completado',
    Tipo: 'Pedido',
    Fecha: dia(PERIODO, 10),
    CompletadoEn: instante(PERIODO, 12),
    LocalId: '000010',
    AlmacenOrigenId: 'ALM-GEN',
    lineas_rev: 1,
    ...campos,
  };
}

export function lineaPedido(pedidoId, index, campos = {}) {
  return {
    PedidoId: pedidoId,
    LineaIndex: index,
    ProductId: 'P1',
    ProductoNombre: 'Producto 1',
    Cantidad: 1,
    TotalLinea: 100,
    ...campos,
  };
}

/**
 * Línea con rappel. Se separa de `lineaPedido` porque el rappel es opcional en el
 * modelo real: la mayoría de las líneas no lo llevan y las pruebas de ventas no
 * deben verse afectadas por él.
 */
export function lineaConRappel(pedidoId, index, rappel, campos = {}) {
  return lineaPedido(pedidoId, index, { TotalRappel: rappel, ...campos });
}

/** Serie de ventas válida: tipo OUT y activa. */
export function serie(nombre = 'FMI', extra = {}) {
  return { serie: nombre, tipo: 'OUT', activa: true, ultimo_numero: 0, ...extra };
}

export function ajustesCompras(extra = {}) {
  return {
    PK: 'compras',
    SK: 'facturacion',
    id_empresa_almacen_general: EMPRESA_CENTRAL,
    serie_ventas: 'FMI',
    serie_rappel: 'FRAPPEL',
    dia_generacion: 1,
    hora: '06:00',
    condiciones_pago: 'Compensación entre sociedades del grupo',
    // El motor lo lee con mayúscula y solo lo da por activo si es exactamente
    // `true`: cualquier otra cosa deja la generación automática apagada.
    Enabled: false,
    ...extra,
  };
}
