import test from 'node:test';
import assert from 'node:assert/strict';

test('un registro antiguo sin gsi queda con las claves de una escritura nueva', async () => {
  const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
  const { docClient } = await import('../lib/db.js');
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const { clavesIndiceFactura } = await import('../lib/facturacion/clavesIndice.js');
  const { clavesPedido } = await import('../lib/clavesIndice.js');
  const {
    ALIAS_TABLAS,
    diffClavesGsi,
    planBackfill,
    paramsUpdateClaves,
  } = await import('../scripts/backfill-claves-gsi.mjs');

  assert.equal(ALIAS_TABLAS.includes('comprasProveedor'), false);

  const db = montarEscenario();
  const factura = {
    id_factura: 'F-VIEJA',
    tipo: 'IN',
    estado: 'pendiente_pago',
    fecha_emision: '2026-03-15',
    empresa_cif: 'b-12345678',
    emisor_id: '7',
    serie: 'FR',
    gsi_fecha: '',
    gsi_periodo: 'viejo',
  };
  db.sembrar(tables.facturas, factura);

  const plan = await planBackfill('facturas', factura);
  const directo = diffClavesGsi(factura, clavesIndiceFactura(factura));
  assert.equal(plan.omitir, false);
  assert.equal(plan.cambia, true);
  assert.deepEqual(plan.set, directo.set);
  assert.deepEqual(plan.remove, directo.remove);
  assert.equal(plan.set.gsi_tipo, 'IN');
  assert.equal(plan.set.gsi_estado, 'pendiente_pago');
  assert.equal(plan.set.gsi_fecha, '2026-03-15');
  assert.equal(plan.set.gsi_proveedor, 'B12345678');
  assert.equal(plan.set.gsi_emisor, '000007');
  assert.equal(plan.set.gsi_serie, 'FR');
  assert.equal(plan.set.gsi_periodo, undefined);
  assert.ok(plan.remove.includes('gsi_periodo'));
  assert.equal(plan.remove.includes('gsi_fecha'), false);
  for (const valor of Object.values(plan.set)) assert.notEqual(valor, '');

  const params = paramsUpdateClaves({ id_factura: 'F-VIEJA' }, plan);
  assert.match(params.ConditionExpression, /attribute_exists\(#k0\)/);
  assert.equal(params.ExpressionAttributeNames['#k0'], 'id_factura');
  assert.match(params.UpdateExpression, /^SET /);
  assert.match(params.UpdateExpression, / REMOVE /);
  for (const valor of Object.values(params.ExpressionAttributeValues)) {
    assert.notEqual(valor, '');
  }

  await docClient.send(new UpdateCommand({ TableName: tables.facturas, ...params }));
  const guardada = db.obtener(tables.facturas, { id_factura: 'F-VIEJA' });
  assert.equal(guardada.gsi_tipo, 'IN');
  assert.equal(guardada.gsi_estado, 'pendiente_pago');
  assert.equal(guardada.gsi_fecha, '2026-03-15');
  assert.equal(guardada.gsi_proveedor, 'B12345678');
  assert.equal(guardada.gsi_emisor, '000007');
  assert.equal(guardada.gsi_serie, 'FR');
  assert.equal(guardada.gsi_periodo, undefined);
  assert.equal((await planBackfill('facturas', guardada)).cambia, false);

  await assert.rejects(
    () => docClient.send(new UpdateCommand({
      TableName: tables.facturas,
      ...paramsUpdateClaves({ id_factura: 'NO-EXISTE' }, plan),
    })),
    { name: 'ConditionalCheckFailedException' },
  );
  assert.equal(db.obtener(tables.facturas, { id_factura: 'NO-EXISTE' }), null);

  const pedido = { Id: 'P1', LocalId: '000010', Estado: 'Enviado', Fecha: '12/03/2026' };
  db.sembrar(tables.pedidos, pedido);
  const planPedido = await planBackfill('pedidos', pedido);
  assert.deepEqual(planPedido.set, diffClavesGsi(pedido, clavesPedido(pedido)).set);
  assert.equal(planPedido.set.gsi_local, '000010');
  assert.equal(planPedido.set.gsi_estado, 'Enviado');
  assert.equal(planPedido.set.gsi_fecha, '2026-03-12');
  assert.deepEqual(planPedido.remove, []);
  await docClient.send(new UpdateCommand({
    TableName: tables.pedidos,
    ...paramsUpdateClaves({ Id: 'P1' }, planPedido),
  }));
  const pedidoGuardado = db.obtener(tables.pedidos, { Id: 'P1' });
  assert.equal(pedidoGuardado.gsi_fecha, '2026-03-12');
  assert.equal((await planBackfill('pedidos', pedidoGuardado)).cambia, false);

  db.crearTabla(tables.remesas, {
    hashKey: 'remesaId',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Activa-index': { hashKey: 'gsi_activa', rangeKey: 'gsi_fecha' },
    },
  });
  const remesa = {
    remesaId: 'R1',
    estado: 'Ejecutada',
    creadoEn: '2026-08-11T10:00:00.000Z',
    lineasPendientesPago: [],
    gsi_activa: 'ACTIVA',
    gsi_listado: 'REMESA',
  };
  db.sembrar(tables.remesas, remesa);
  const planRemesa = await planBackfill('remesas', remesa);
  assert.equal(planRemesa.set.gsi_fecha, '2026-08-11');
  assert.equal(planRemesa.set.gsi_activa, undefined);
  assert.deepEqual(planRemesa.remove, ['gsi_activa']);
  await docClient.send(new UpdateCommand({
    TableName: tables.remesas,
    ...paramsUpdateClaves({ remesaId: 'R1' }, planRemesa),
  }));
  const remesaGuardada = db.obtener(tables.remesas, { remesaId: 'R1' });
  assert.equal(remesaGuardada.gsi_listado, 'REMESA');
  assert.equal(remesaGuardada.gsi_fecha, '2026-08-11');
  assert.equal(remesaGuardada.gsi_activa, undefined);
  assert.equal((await planBackfill('remesas', remesaGuardada)).cambia, false);
});

test('no escribe cadena vacía y solo decide las negociaciones META', async () => {
  await import('./escenarioFacturacion.mjs');
  const { planBackfill, paramsUpdateClaves, diffClavesGsi } = await import('../scripts/backfill-claves-gsi.mjs');

  const sinFecha = {
    id_factura: 'F-SIN',
    tipo: ' ',
    estado: '',
    fecha_emision: 'ayer',
    creado_en: 'no-fecha',
    gsi_tipo: '',
    gsi_fecha: '',
  };
  const plan = await planBackfill('facturas', sinFecha);
  assert.deepEqual(plan.set, {});
  assert.deepEqual(plan.remove, ['gsi_tipo', 'gsi_fecha']);
  for (const valor of Object.values(plan.set)) assert.notEqual(valor, '');
  assert.throws(
    () => paramsUpdateClaves({ id_factura: 'F-SIN' }, { set: { gsi_tipo: '' }, remove: [] }),
    /no escribible/,
  );
  assert.equal(diffClavesGsi({ id_factura: 'X' }, { poner: {}, quitar: ['gsi_tipo'] }).cambia, false);

  const linea = { PK: 'N1', SK: 'LINEA#1', fecha: '2026-01-01', gsi_listado: 'NEG' };
  assert.equal((await planBackfill('negociaciones', linea)).omitir, true);
  const meta = { PK: 'N1', SK: 'META', fecha: '2026-01-02' };
  const planMeta = await planBackfill('negociaciones', meta);
  assert.equal(planMeta.omitir, false);
  assert.equal(planMeta.set.gsi_listado, 'NEG');
  assert.equal(planMeta.set.gsi_fecha, '2026-01-02');

  const yaBien = { ...meta, gsi_listado: 'NEG', gsi_fecha: '2026-01-02' };
  assert.equal((await planBackfill('negociaciones', yaBien)).cambia, false);
});
