/**
 * S-16: dos pagos (o un pago y un borrado) a la vez sobre la misma factura. Antes
 * los dos leían la factura, cada uno sumaba su importe al total leído y el
 * segundo Put pisaba al primero: los dos pagos quedaban en Igp_FacturasPagos y el
 * saldo solo descontaba uno. Ahora la factura se guarda con condición de versión,
 * pago y saldo en la misma transacción, y el perdedor relee y reintenta.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { docClient } = await import('../lib/db.js');
const { registrarPagoFactura } = await import('../lib/facturacion/registrarPago.js');
const { eliminarPagoFactura } = await import('../lib/facturacion/eliminarPago.js');
const { MENSAJE_FACTURA_CAMBIADA } = await import('../lib/facturacion/versionFactura.js');

function escenario(extra = {}) {
  const db = montarEscenario();
  db.crearTabla(tables.facturasPagos, { hashKey: 'id_factura', rangeKey: 'id_pago' });
  db.crearTabla(tables.remesas, { hashKey: 'remesaId' });
  db.sembrar(tables.facturas, {
    id_factura: 'FAC-1',
    tipo: 'IN',
    estado: 'pendiente_pago',
    total_factura: 100,
    total_cobrado: 0,
    saldo_pendiente: 100,
    emisor_id: '000001',
    version: 2,
    ...extra,
  });
  return db;
}

const pagar = (importe, extra = {}) => registrarPagoFactura({
  id_factura: 'FAC-1',
  fecha: '2026-10-01',
  importe,
  metodo_pago: 'transferencia',
  ...extra,
});

const factura = (db) => db.obtener(tables.facturas, { id_factura: 'FAC-1' });
const pagos = (db) => db.listar(tables.facturasPagos).filter((p) => p.id_factura === 'FAC-1');

test('otro pago entre la lectura y la escritura: los dos pagos quedan y el saldo descuenta ambos', async () => {
  const db = escenario();
  // El segundo pago entra completo justo cuando el primero va a escribir.
  db.interceptar('TransactWriteCommand', undefined, () => pagar(20));
  const r = await pagar(30);

  assert.equal(r.ok, true);
  assert.deepEqual(pagos(db).map((p) => [p.id_pago, p.importe]).sort(), [['P001', 20], ['P002', 30]]);
  const f = factura(db);
  assert.equal(f.total_cobrado, 50);
  assert.equal(f.saldo_pendiente, 50);
  assert.equal(f.estado, 'parcialmente_pagada');
  assert.equal(f.version, 4);
});

test('dos pagos lanzados a la vez (Promise.all): ambos quedan y el saldo cuadra', async () => {
  const db = escenario();
  const [a, b] = await Promise.all([pagar(40), pagar(25)]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(pagos(db).length, 2);
  assert.notEqual(pagos(db)[0].id_pago, pagos(db)[1].id_pago);
  assert.equal(factura(db).total_cobrado, 65);
  assert.equal(factura(db).saldo_pendiente, 35);
});

test('al reintentar se respeta el saldo releído: el segundo no puede sobrepagar', async () => {
  const db = escenario();
  db.interceptar('TransactWriteCommand', undefined, () => pagar(80));
  await assert.rejects(() => pagar(30), (err) => err.status === 400 && /supera el pendiente/.test(err.message));
  assert.equal(pagos(db).length, 1);
  assert.equal(factura(db).total_cobrado, 80);
});

test('misma clave de idempotencia a la vez: un solo pago', async () => {
  const db = escenario();
  db.interceptar('TransactWriteCommand', undefined, () => pagar(30, { idempotencyKey: 'banca:H1:FAC-1' }));
  const r = await pagar(30, { idempotencyKey: 'banca:H1:FAC-1' });
  assert.equal(r.idempotent, true);
  assert.equal(pagos(db).length, 1);
  assert.equal(factura(db).total_cobrado, 30);
});

test('factura antigua sin version: se acepta y queda versionada', async () => {
  const db = escenario({ version: undefined });
  await pagar(10);
  assert.equal(factura(db).version, 2);
  assert.equal(factura(db).total_cobrado, 10);
});

test('si la factura sigue cambiando en cada intento: 409 en español y no se escribe el pago', async () => {
  const db = escenario();
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'TransactWriteCommand') {
      const f = factura(db);
      db.sembrar(tables.facturas, { ...f, version: f.version + 1 });
    }
    return enviar(cmd);
  };
  try {
    await assert.rejects(
      () => pagar(10),
      (err) => err.status === 409 && err.message === MENSAJE_FACTURA_CAMBIADA && err.code === 'FACTURA_CAMBIADA',
    );
  } finally {
    docClient.send = enviar;
  }
  assert.equal(pagos(db).length, 0);
  assert.equal(factura(db).total_cobrado, 0);
});

for (const [caso, error] of [
  ['transacción cancelada por TransactionConflict', Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }],
  })],
  ['TransactionConflictException (escritura suelta contra una transacción)', Object.assign(new Error('conflict'), {
    name: 'TransactionConflictException',
  })],
]) {
  test(`${caso}: se reintenta y el pago entra una vez`, async () => {
    const db = escenario();
    const enviar = docClient.send;
    let fallos = 0;
    docClient.send = async (cmd) => {
      if (cmd?.constructor?.name === 'TransactWriteCommand' && fallos === 0) {
        fallos += 1;
        throw error;
      }
      return enviar(cmd);
    };
    try {
      const r = await pagar(15);
      assert.equal(r.ok, true);
    } finally {
      docClient.send = enviar;
    }
    assert.equal(fallos, 1);
    assert.equal(pagos(db).length, 1);
    assert.equal(factura(db).total_cobrado, 15);
  });
}

test('un error que no es de conflicto no se reintenta', async () => {
  escenario();
  const enviar = docClient.send;
  let intentos = 0;
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name === 'TransactWriteCommand') {
      intentos += 1;
      throw Object.assign(new Error('throttled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: 'ThrottlingError' }],
      });
    }
    return enviar(cmd);
  };
  try {
    await assert.rejects(() => pagar(15), (err) => err.name === 'TransactionCanceledException');
  } finally {
    docClient.send = enviar;
  }
  assert.equal(intentos, 1);
});

test('borrar un pago mientras entra otro: el borrado relee y el saldo queda bien', async () => {
  const db = escenario();
  await pagar(30);
  db.interceptar('TransactWriteCommand', undefined, () => pagar(20));
  await eliminarPagoFactura({ id_factura: 'FAC-1', id_pago: 'P001' });

  assert.deepEqual(pagos(db).map((p) => [p.id_pago, p.importe]), [['P002', 20]]);
  assert.equal(factura(db).total_cobrado, 20);
  assert.equal(factura(db).saldo_pendiente, 80);
});

test('dos borrados del mismo pago a la vez: se resta una sola vez y el otro da 404', async () => {
  const db = escenario();
  await pagar(30);
  await pagar(20);
  const r = await Promise.allSettled([
    eliminarPagoFactura({ id_factura: 'FAC-1', id_pago: 'P001' }),
    eliminarPagoFactura({ id_factura: 'FAC-1', id_pago: 'P001' }),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(r.find((x) => x.status === 'rejected').reason.status, 404);
  assert.equal(factura(db).total_cobrado, 20);
});
