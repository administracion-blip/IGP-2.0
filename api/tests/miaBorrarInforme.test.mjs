/**
 * Borrar un informe MIA quita la cabecera y las líneas. No existe llamada a Ágora.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { deleteInforme, getInformeMeta, listInformeLineas } = await import('../lib/mia/informes.js');

test('deleteInforme borra cabecera y líneas y devuelve el pedido de Ágora', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  db.sembrar(tables.miaInformes, {
    PK: 'INFORME#inf-b',
    SK: 'META',
    informeId: 'inf-b',
    WarehouseId: '000001',
    estado: 'aprobado',
    agoraPurchaseOrderIds: { '20': { serie: 'MIA', number: 941449357, ok: true } },
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-b', SK: 'LINE#20#6740', informeId: 'inf-b', productId: '6740',
  });
  db.sembrar(tables.miaInformeLineas, {
    PK: 'INFORME#inf-b', SK: 'LINE#20#2736', informeId: 'inf-b', productId: '2736',
  });

  const out = await deleteInforme('inf-b');
  assert.equal(out.informeId, 'inf-b');
  assert.deepEqual(out.pedidosAgora, [{ serie: 'MIA', number: 941449357 }]);
  assert.equal(await getInformeMeta('inf-b'), null);
  assert.deepEqual(await listInformeLineas('inf-b'), []);
});

test('deleteInforme de un id desconocido responde 404', async () => {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.miaInformes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.miaInformeLineas, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  await assert.rejects(() => deleteInforme('no-esta'), (err) => err.status === 404);
});
