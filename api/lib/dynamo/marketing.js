/**
 * Infraestructura de la tabla `Igp_Marketing` (módulo Marketing / RRSS).
 *
 * Verifica/crea tres GSIs sobre la tabla:
 *   - Local-Estado-index   PK: id_local       SK: estado
 *   - Local-Fecha-index    PK: id_local       SK: fecha_sugerida
 *   - Empresa-Estado-index PK: id_empresa     SK: estado
 *
 * Patrón calcado de `usuarios.js`/`comprasProveedor.js`: ensure on boot,
 * idempotente, nunca lanza, fallback a Scan en las rutas mientras un
 * índice está en CREATING.
 *
 * Detalle operativo: DynamoDB rechaza un `UpdateTableCommand` con `Create`
 * mientras la tabla está en estado UPDATING (porque otro GSI se está
 * creando). Cada GSI tarda varios minutos en pasar de CREATING a ACTIVE.
 * En la práctica eso significa que `ensureMarketingGSIs()` solo conseguirá
 * crear UN GSI por arranque exitoso: el primer arranque crea el primero,
 * el segundo arranque (5–10 min después) crea el siguiente, etc. Es el
 * comportamiento esperado y no un bug — los flags de readiness y el
 * fallback a Scan en las rutas cubren la ventana intermedia.
 *
 * Alternativa: el operador puede crear los 3 GSIs manualmente en la
 * consola AWS antes del despliegue. Esta función los detectará como
 * existentes y solo activará los flags.
 */

import { DescribeTableCommand, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { client, tables } from '../db.js';

const TABLE_NAME = tables.marketing;

export const GSI_LOCAL_ESTADO_NAME = 'Local-Estado-index';
export const GSI_LOCAL_FECHA_NAME = 'Local-Fecha-index';
export const GSI_EMPRESA_ESTADO_NAME = 'Empresa-Estado-index';

const flags = {
  localEstado: false,
  localFecha: false,
  empresaEstado: false,
};

export function isMarketingLocalEstadoReady() {
  return flags.localEstado;
}

export function isMarketingLocalFechaReady() {
  return flags.localFecha;
}

export function isMarketingEmpresaEstadoReady() {
  return flags.empresaEstado;
}

const GSI_DEFS = [
  { name: GSI_LOCAL_ESTADO_NAME, flag: 'localEstado', hash: 'id_local', range: 'estado' },
  { name: GSI_LOCAL_FECHA_NAME, flag: 'localFecha', hash: 'id_local', range: 'fecha_sugerida' },
  { name: GSI_EMPRESA_ESTADO_NAME, flag: 'empresaEstado', hash: 'id_empresa', range: 'estado' },
];

async function createGsi(name, hashKey, rangeKey, billingMode) {
  await client.send(new UpdateTableCommand({
    TableName: TABLE_NAME,
    AttributeDefinitions: [
      { AttributeName: hashKey, AttributeType: 'S' },
      { AttributeName: rangeKey, AttributeType: 'S' },
    ],
    GlobalSecondaryIndexUpdates: [{
      Create: {
        IndexName: name,
        KeySchema: [
          { AttributeName: hashKey, KeyType: 'HASH' },
          { AttributeName: rangeKey, KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
        ProvisionedThroughput: billingMode === 'PAY_PER_REQUEST'
          ? undefined
          : { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      },
    }],
  }));
}

export async function ensureMarketingGSIs() {
  let desc;
  try {
    desc = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
  } catch (err) {
    console.warn(
      `[GSI] No se pudo describir ${TABLE_NAME}: ${err?.message || err}. ` +
      `Los GSIs de Marketing quedan en estado pendiente; se reintentará en próximo arranque.`,
    );
    return;
  }

  const existingGsis = desc.Table?.GlobalSecondaryIndexes || [];
  const billingMode = desc.Table?.BillingModeSummary?.BillingMode;

  for (const def of GSI_DEFS) {
    try {
      const existing = existingGsis.find((g) => g.IndexName === def.name);
      if (existing) {
        flags[def.flag] = existing.IndexStatus === 'ACTIVE';
        if (flags[def.flag]) {
          console.log(`[GSI] ${def.name} activo y listo`);
        } else {
          console.log(`[GSI] ${def.name} existe pero está en estado ${existing.IndexStatus}, usando Scan como fallback`);
        }
        continue;
      }
      console.log(`[GSI] Creando ${def.name} en ${TABLE_NAME}…`);
      await createGsi(def.name, def.hash, def.range, billingMode);
      console.log(
        `[GSI] ${def.name} creación iniciada. Estará activo en unos minutos. ` +
        `Usando Scan como fallback mientras tanto.`,
      );
    } catch (err) {
      const errName = err?.name || '';
      const msg = String(err?.message || '');
      if (errName === 'ResourceInUseException' || /UPDATING|in use/i.test(msg)) {
        console.warn(
          `[GSI] ${def.name} no se pudo crear ahora (tabla en UPDATING por otro GSI). ` +
          `Se reintentará en el próximo arranque.`,
        );
      } else {
        console.warn(`[GSI] Error verificando/creando ${def.name}: ${msg || err}`);
      }
    }
  }
}
