import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION || 'eu-west-3';

export const client = new DynamoDBClient({ region });
export const docClient = DynamoDBDocumentClient.from(client);

/** Nombres de tabla (necesarios para borrado legacy). Debe ir antes de deleteItemBySchema. */
export const tables = {
  usuarios: process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios',
  locales: process.env.DDB_LOCALES || 'igp_Locales',
  empresas: process.env.DDB_EMPRESAS || 'igp_Empresas',
  productos: process.env.DDB_PRODUCTOS || 'igp_Productos',
  almacenes: process.env.DDB_ALMACENES || 'igp_Almacenes',
  saleCenters: process.env.DDB_SALE_CENTERS_TABLE || 'Igp_SaleCenters',
  /** Plantillas de franjas horarias para "ventas por horas" en Objetivos. PK = "GLOBAL", SK = plantillaId. */
  franjasHorarias: process.env.DDB_FRANJAS_HORARIAS_TABLE || 'Igp_FranjasHorarias',
  agoraProducts: process.env.DDB_AGORA_PRODUCTS_TABLE || 'Igp_AgoraProducts',
  agoraUsuarios: process.env.DDB_AGORA_USUARIOS_TABLE || 'Igp_AgoraUsuarios',
  salesCloseOuts: process.env.DDB_SALES_CLOSEOUTS_TABLE || 'Igp_SalesCloseouts',
  mantenimiento: process.env.DDB_MANTENIMIENTO_TABLE || 'Igp_Mantenimiento',
  rolesPermisos: process.env.DDB_ROLES_PERMISOS_TABLE || 'Igp_RolesPermisos',
  gestionFestivos: process.env.DDB_GESTION_FESTIVOS_TABLE || 'Igp_Gestionfestivosyestimaciones',
  pedidos: process.env.DDB_PEDIDOS || 'Igp_Pedidos',
  pedidosLineas: process.env.DDB_PEDIDOS_LINEAS || 'Igp_PedidosLineas',
  comprasProveedor: process.env.DDB_COMPRAS_PROVEEDOR || 'Igp_ComprasAProveedor',
  acuerdos: process.env.DDB_ACUERDOS || 'Igp_Acuerdos',
  acuerdosDetalles: process.env.DDB_ACUERDOS_DETALLES || 'Igp_AcuerdosDetalles',
  acuerdosImagen: process.env.DDB_ACUERDOS_IMAGEN || 'Igp_AcuerdosImagen',
  facturas: process.env.DDB_FACTURAS || 'Igp_Facturas',
  facturasLineas: process.env.DDB_FACTURAS_LINEAS || 'Igp_FacturasLineas',
  facturasPagos: process.env.DDB_FACTURAS_PAGOS || 'Igp_FacturasPagos',
  facturasSeries: process.env.DDB_FACTURAS_SERIES || 'Igp_FacturasSeries',
  facturasAuditoria: process.env.DDB_FACTURAS_AUDITORIA || 'Igp_FacturasAuditoria',
  ajustes: process.env.DDB_AJUSTES || 'Igp_Ajustes',
  artistas: process.env.DDB_ARTISTAS || 'Igp_Artistas',
  actuaciones: process.env.DDB_ACTUACIONES || 'Igp_Actuaciones',
  arqueosReales: process.env.DDB_ARQUEOS_REALES || 'Igp_ArqueosReales',
  /** Maestro de formas de pago sincronizado desde Ágora. PK = "PM", SK = agoraId. */
  formasPago: process.env.DDB_FORMAS_PAGO || 'Igp_FormasPago',
  /**
   * Movimientos de caja (retiradas de efectivo y transferencias de prepago).
   * PK = workplaceId (agoraCode), SK = `${businessDay}#${posId}#${tipo}#${id}`.
   */
  movimientosCaja: process.env.DDB_MOVIMIENTOS_CAJA || 'Igp_MovimientosCaja',
  /**
   * Cierre de jornada del local: consolida los arqueos de los TPVs de un día.
   * PK = workplaceId (agoraCode), SK = businessDay (YYYY-MM-DD).
   */
  jornadasLocal: process.env.DDB_JORNADAS_LOCAL || 'Igp_JornadasLocal',
  /** Nombre en AWS: Igp_MysteryGuest (DDB_MISTERY_GUEST si difiere). */
  mysteryGuest: process.env.DDB_MISTERY_GUEST || 'Igp_MysteryGuest',
  /** Empleados sincronizados desde Factorial HR. PK = EMPLOYEE#<id>, SK = METADATA. */
  empleados: process.env.DDB_EMPLEADOS || 'Igp_Empleados',
  /** Propuestas del módulo Marketing. PK = id_propuesta. GSIs: Local-Estado-index, Local-Fecha-index, Empresa-Estado-index. */
  marketing: process.env.DDB_MARKETING || 'Igp_Marketing',
  /** Campañas de activación de marcas (ficha maestra). PK = id_activacion. */
  activaciones: process.env.DDB_ACTIVACIONES || 'Igp_Activaciones',
  /** Sesiones programadas de activaciones. PK = id_sesion. GSIs: local-fecha-index, activacion-index. */
  activacionSesiones: process.env.DDB_ACTIVACION_SESIONES || 'Igp_ActivacionSesiones',
  /**
   * Ventas agregadas por producto/día/usuario (sync Ágora).
   * PK = LOCAL#<localId>, SK = DIA#<YYYY-MM-DD>#PROD#<productId>#USER#<agoraUserId>.
   * GSI: ProductId-Fecha-index.
   */
  ventasProducto: process.env.DDB_VENTAS_PRODUCTO_TABLE || 'Igp_VentasProducto',
  /** Campañas de incentivo por producto. PK = campanaId (UUID). */
  campanas: process.env.DDB_CAMPANAS_TABLE || 'Igp_Campanas',
  /** Remesas de pago a proveedores. PK = remesaId (UUID). */
  remesas: process.env.DDB_REMESAS_TABLE || 'Igp_Remesas',
  /** Movimientos cashflow (efectivo fuera TPV). PK LOCAL#id, SK FECHA#date#uuid. */
  cashflow: process.env.DDB_CASHFLOW_TABLE || 'Igp_Cashflow',
  /**
   * Informes generados por el framework de IA. PK = "FUENTE#<clave>",
   * SK = "TS#<ISO>#<informeId>" (historial) o "CACHE#<firma>" (puntero de cache).
   */
  informesIa: process.env.DDB_INFORMES_IA_TABLE || 'Igp_InformesIa',
  /**
   * Plantillas de redacción editables por fuente. PK = "FUENTE#<clave>",
   * SK = "PROMPT#<promptId>".
   */
  iaPrompts: process.env.DDB_IA_PROMPTS_TABLE || 'Igp_IaPrompts',
  /** Limpieza: catálogo de objetos a limpiar. PK = "TIPO", SK = id_tipo. */
  limpiezaTipos: process.env.DDB_LIMPIEZA_TIPOS_TABLE || 'Igp_LimpiezaTipos',
  /**
   * Limpieza: reglas de frecuencia y plantillas. PK = LOCAL#<localId>,
   * SK = REGLA#<uuid> | PLANTILLA#<uuid>. GSI: Tipo-Local-index (tipo → local_id).
   */
  limpiezaProgramacion: process.env.DDB_LIMPIEZA_PROGRAMACION_TABLE || 'Igp_LimpiezaProgramacion',
  /**
   * Limpieza: registros por fecha/local. PK = LOCAL#<localId>,
   * SK = FECHA#<YYYY-MM-DD>#<tipo_objeto_id>. GSI: Fecha-Local-index (fecha_programada → local_id).
   */
  limpiezaRegistros: process.env.DDB_LIMPIEZA_REGISTROS_TABLE || 'Igp_LimpiezaRegistros',
  /**
   * Limpieza: incidencias detectadas al limpiar. PK = LOCAL#<localId>,
   * SK = INC#<ISO>#<uuid>. GSI: Registro-index (registro_id).
   */
  limpiezaIncidencias: process.env.DDB_LIMPIEZA_INCIDENCIAS_TABLE || 'Igp_LimpiezaIncidencias',
};

/**
 * Clave DynamoDB para la tabla principal de facturas cuando solo conoces el id (UUID).
 * Usa DescribeTable: la partición puede ser `id_entrada`, `id_factura`, etc.
 */
export async function keyForFacturaPrincipalId(id) {
  const tableName = tables.facturas;
  const schema = await getTableKeySchema(tableName);
  if (schema.rangeKey) {
    throw new Error(`La tabla ${tableName} tiene clave compuesta; no se puede usar solo el id de factura`);
  }
  return { [schema.hashKey]: String(id) };
}

/**
 * Clave para Get/Update/Delete cuando ya tienes el ítem (p. ej. resultado de Scan).
 */
export async function keyForFacturaItem(item) {
  const tableName = tables.facturas;
  const schema = await getTableKeySchema(tableName);
  const Key = buildDynamoKeyFromItem(item, schema);
  if (!Key) {
    throw new Error(
      `El ítem de factura no incluye los atributos de clave (${schema.hashKey}${schema.rangeKey ? `, ${schema.rangeKey}` : ''})`,
    );
  }
  return Key;
}

/** Caché de esquema de clave por nombre de tabla (DescribeTable). */
const tableKeySchemaCache = new Map();

/**
 * Devuelve los nombres de atributo que forman la clave primaria en DynamoDB.
 * @returns {{ hashKey: string, rangeKey?: string }}
 */
export async function getTableKeySchema(tableName) {
  if (tableKeySchemaCache.has(tableName)) {
    return tableKeySchemaCache.get(tableName);
  }
  const out = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const ks = out.Table?.KeySchema || [];
  const hashKey = ks.find((k) => k.KeyType === 'HASH')?.AttributeName;
  const rangeKey = ks.find((k) => k.KeyType === 'RANGE')?.AttributeName;
  if (!hashKey) {
    throw new Error(`DescribeTable: la tabla ${tableName} no tiene clave HASH`);
  }
  const schema = { hashKey, ...(rangeKey ? { rangeKey } : {}) };
  tableKeySchemaCache.set(tableName, schema);
  return schema;
}

function firstDefined(item, names) {
  for (const n of names) {
    if (n && item[n] !== undefined && item[n] !== null && item[n] !== '') {
      return item[n];
    }
  }
  return undefined;
}

function resolveRangeValue(item, rangeKey) {
  let v = item[rangeKey];
  if (v !== undefined && v !== null && v !== '') return v;
  if (rangeKey === 'timestamp_accion') {
    return firstDefined(item, ['timestamp_accion', 'creado_en']);
  }
  if (rangeKey === 'id_pago') return item.id_pago;
  if (rangeKey === 'id_linea') return item.id_linea;
  if (rangeKey === 'id_entrada') {
    return firstDefined(item, ['id_entrada', 'timestamp_accion']);
  }
  return undefined;
}

/**
 * Construye el objeto `Key` para GetItem/DeleteItem a partir de un ítem devuelto por Scan/Query.
 * Usa alias entre id_entrada / id_factura en la partición (mismo UUID en facturas).
 */
export function buildDynamoKeyFromItem(item, schema) {
  if (!item || !schema?.hashKey) return null;
  const hashVal = firstDefined(item, [schema.hashKey, 'id_entrada', 'id_factura', 'PK']);
  if (hashVal === undefined) return null;
  const key = { [schema.hashKey]: hashVal };
  if (schema.rangeKey) {
    const rangeVal = resolveRangeValue(item, schema.rangeKey);
    if (rangeVal === undefined || rangeVal === null || rangeVal === '') return null;
    key[schema.rangeKey] = rangeVal;
  }
  return key;
}

function isSchemaKeyError(e) {
  return (
    e?.name === 'ValidationException' ||
    /schema|key element|does not match/i.test(String(e?.message || ''))
  );
}

/**
 * Intentos de clave sin DescribeTable (datos legacy o permisos limitados).
 */
async function deleteItemLegacy(tableName, item) {
  const fid = item.id_factura || item.id_entrada;
  const candidates = [];

  if (tableName === tables.facturasPagos) {
    if (fid && item.id_pago) candidates.push({ id_factura: fid, id_pago: item.id_pago });
    if (item.id_entrada) candidates.push({ id_entrada: item.id_entrada });
    if (fid && item.id_pago) candidates.push({ id_entrada: `${fid}#${item.id_pago}` });
  } else if (tableName === tables.facturasLineas) {
    if (fid && item.id_linea) candidates.push({ id_factura: fid, id_linea: item.id_linea });
    if (item.id_entrada) candidates.push({ id_entrada: item.id_entrada });
    if (fid && item.id_linea) candidates.push({ id_entrada: `${fid}#${item.id_linea}` });
  } else if (tableName === tables.facturasAuditoria) {
    if (fid && item.id_entrada) candidates.push({ id_factura: fid, id_entrada: item.id_entrada });
    if (fid && item.timestamp_accion) candidates.push({ id_factura: fid, timestamp_accion: item.timestamp_accion });
    if (item.id_entrada) candidates.push({ id_entrada: item.id_entrada });
    if (item.id_entrada && item.timestamp_accion) {
      candidates.push({ id_entrada: item.id_entrada, timestamp_accion: item.timestamp_accion });
    }
  } else if (tableName === tables.facturas) {
    if (item.id_entrada) candidates.push({ id_entrada: item.id_entrada });
    if (item.id_factura) candidates.push({ id_factura: item.id_factura });
  }

  const uniq = [];
  const seen = new Set();
  for (const k of candidates) {
    const s = JSON.stringify(k);
    if (seen.has(s)) continue;
    seen.add(s);
    uniq.push(k);
  }

  let lastErr;
  for (const Key of uniq) {
    try {
      await docClient.send(new DeleteCommand({ TableName: tableName, Key }));
      return;
    } catch (e) {
      lastErr = e;
      if (!isSchemaKeyError(e)) throw e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`deleteItemLegacy: sin candidatos de clave para ${tableName}`);
}

/**
 * DeleteItem: DescribeTable + clave desde ítem; si DescribeTable o Delete fallan por clave, reintento legacy.
 */
export async function deleteItemBySchema(tableName, item) {
  let schema;
  try {
    schema = await getTableKeySchema(tableName);
  } catch (e) {
    console.warn('[deleteItemBySchema] DescribeTable falló, usando claves legacy:', tableName, e?.message);
    return deleteItemLegacy(tableName, item);
  }

  const Key = buildDynamoKeyFromItem(item, schema);
  if (!Key) {
    console.warn('[deleteItemBySchema] ítem sin atributos de clave reconocibles, legacy:', tableName);
    return deleteItemLegacy(tableName, item);
  }

  try {
    await docClient.send(new DeleteCommand({ TableName: tableName, Key }));
  } catch (e) {
    if (isSchemaKeyError(e)) {
      console.warn('[deleteItemBySchema] Delete falló (clave), legacy:', tableName, e?.message);
      return deleteItemLegacy(tableName, item);
    }
    throw e;
  }
}
