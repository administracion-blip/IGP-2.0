/**
 * `checkAutoSyncs` lee la configuración con un Query por la partición
 * 'sincronizaciones' (paginado), no con un Scan de toda Igp_Ajustes.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { checkAutoSyncs } = await import('../lib/jobs/scheduledTasks.js');

const recibidas = [];
const servidor = http.createServer((req, res) => {
  recibidas.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
const puerto = servidor.address().port;

after(() => {
  servidor.closeAllConnections?.();
  servidor.close();
});

const DIAS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Minuto actual y el siguiente, para no fallar si el reloj cambia de minuto. */
function minutosCercanos() {
  const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ahora = new Date();
  return [fmt(ahora), fmt(new Date(ahora.getTime() + 60_000))];
}

test('checkAutoSyncs consulta la partición sincronizaciones con Query paginado y ejecuta solo Enabled === true', async () => {
  const db = crearDynamoMemoria({ paginaTam: 1 });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  const Times = minutosCercanos();
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'agora_productos', Enabled: true, Days: DIAS, Times });
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'closeouts', Enabled: false, Days: DIAS, Times });
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'formas_pago', Enabled: true, Days: DIAS, Times });
  // Otra partición con la misma forma: no debe ejecutarse.
  db.sembrar(tables.ajustes, { PK: 'otros', SK: 'agora_usuarios', Enabled: true, Days: DIAS, Times });

  // `Enabled` en texto no cuenta: solo el booleano true.
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'mia_stocks', Enabled: 'true', Days: DIAS, Times });

  const entradas = [];
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    entradas.push({ tipo: cmd?.constructor?.name, input: cmd.input });
    return enviar(cmd);
  };
  await checkAutoSyncs(puerto);

  const lecturas = entradas.filter((e) => e.tipo === 'QueryCommand' || e.tipo === 'ScanCommand');
  assert.equal(lecturas.length, 4, 'con páginas de 1, una lectura por ítem de la partición');
  for (const { tipo, input } of lecturas) {
    assert.equal(tipo, 'QueryCommand');
    assert.equal(input.TableName, tables.ajustes);
    assert.equal(input.KeyConditionExpression, 'PK = :pk');
    assert.equal(input.FilterExpression, undefined);
    assert.equal(input.ExpressionAttributeValues[':pk'], 'sincronizaciones');
  }
  assert.ok(lecturas.slice(1).every((l) => l.input.ExclusiveStartKey), 'pagina con LastEvaluatedKey');

  assert.deepEqual(recibidas.sort(), ['/api/agora/payment-methods/sync', '/api/agora/products/sync']);
  const productos = db.obtener(tables.ajustes, { PK: 'sincronizaciones', SK: 'agora_productos' });
  assert.equal(productos.Estado, 'ok');
  assert.equal(db.obtener(tables.ajustes, { PK: 'sincronizaciones', SK: 'closeouts' }).Estado, undefined);
  assert.equal(db.obtener(tables.ajustes, { PK: 'sincronizaciones', SK: 'mia_stocks' }).Estado, undefined);
});
