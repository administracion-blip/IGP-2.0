import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const region = process.env.AWS_REGION || 'eu-west-3';

const client = new DynamoDBClient({ region });
export const docClient = DynamoDBDocumentClient.from(client);

export const tables = {
  usuarios: process.env.DDB_USUARIOS || process.env.DYNAMODB_TABLE || 'igp_usuarios',
  locales: process.env.DDB_LOCALES || 'igp_Locales',
  empresas: process.env.DDB_EMPRESAS || 'igp_Empresas',
  productos: process.env.DDB_PRODUCTOS || 'igp_Productos',
  almacenes: process.env.DDB_ALMACENES || 'igp_Almacenes',
  saleCenters: process.env.DDB_SALE_CENTERS_TABLE || 'Igp_SaleCenters',
  agoraProducts: process.env.DDB_AGORA_PRODUCTS_TABLE || 'Igp_AgoraProducts',
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
};
