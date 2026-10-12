/**
 * S-18: cada escritura de clave GSI rellena gsi_* y nunca persiste ''.
 * Fichero aparte de clavesIndice.test.mjs (facturas y remesas).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient } from '../lib/db.js';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';
import {
  aplicarClavesGsi,
  clavesAcuerdoDetalle,
  clavesActuacion,
  clavesComprasProveedor,
  clavesEmpresa,
  clavesFicheroBanca,
  clavesMantenimiento,
  clavesMovimientoBanca,
  clavesMysteryGuest,
  clavesNegociacionMeta,
  clavesPedido,
  clavesRefacturacion,
  fusionarClavesUpdate,
  omitirClavesGsi,
} from '../lib/clavesIndice.js';

function memoria(nombre, hashKey, rangeKey) {
  const db = crearDynamoMemoria();
  db.crearTabla(nombre, rangeKey ? { hashKey, rangeKey } : { hashKey });
  db.instalar(docClient);
  return db;
}

async function guardar(tabla, item, key) {
  await docClient.send(new PutCommand({ TableName: tabla, Item: item }));
  const r = await docClient.send(new GetCommand({ TableName: tabla, Key: key }));
  return r.Item;
}

function sinGsiVacio(item) {
  for (const [k, v] of Object.entries(item)) {
    if (k.startsWith('gsi_')) assert.notEqual(v, '', `${k} no puede guardarse vacío`);
  }
}

test('empresas: gsi_cif normalizado y ausente si el CIF no vale', async () => {
  const tabla = 't-empresas';
  memoria(tabla, 'id');
  const buena = aplicarClavesGsi(
    { id: '1', Cif: 'b-12.345.678' },
    clavesEmpresa('b-12.345.678'),
  );
  const leida = await guardar(tabla, buena, { id: '1' });
  assert.equal(leida.gsi_cif, 'B12345678');
  sinGsiVacio(leida);

  const vacia = aplicarClavesGsi({ id: '2', Cif: '---', gsi_cif: '' }, clavesEmpresa('---'));
  const leidaVacia = await guardar(tabla, vacia, { id: '2' });
  assert.equal(leidaVacia.gsi_cif, undefined);
  sinGsiVacio(leidaVacia);
});

test('compras a proveedor: gsi_mes y gsi_fecha, omitidos si la fecha no vale', async () => {
  const tabla = 't-compras';
  memoria(tabla, 'PK', 'SK');
  const linea = { PK: 'A#1', SK: '0001', AlbaranFecha: '2026-03-15' };
  aplicarClavesGsi(linea, clavesComprasProveedor(linea.AlbaranFecha));
  const leida = await guardar(tabla, linea, { PK: 'A#1', SK: '0001' });
  assert.equal(leida.gsi_mes, '2026-03');
  assert.equal(leida.gsi_fecha, '2026-03-15');
  sinGsiVacio(leida);

  const mala = { PK: 'A#2', SK: '0001', AlbaranFecha: '' };
  aplicarClavesGsi(mala, clavesComprasProveedor(''));
  const leidaMala = await guardar(tabla, mala, { PK: 'A#2', SK: '0001' });
  assert.equal(leidaMala.gsi_mes, undefined);
  assert.equal(leidaMala.gsi_fecha, undefined);
  sinGsiVacio(leidaMala);
});

test('pedidos: Fecha dd/mm/aaaa acaba en gsi_fecha ISO y el local vacío no se escribe', async () => {
  const tabla = 't-pedidos';
  memoria(tabla, 'Id');
  const alta = {
    Id: 'PED-2026-00001',
    LocalId: '  42 ',
    Estado: '',
    Fecha: '12/03/2026',
  };
  aplicarClavesGsi(alta, clavesPedido(alta));
  const leida = await guardar(tabla, alta, { Id: alta.Id });
  assert.equal(leida.gsi_local, '42');
  assert.equal(leida.gsi_estado, 'Borrador');
  assert.equal(leida.gsi_fecha, '2026-03-12');
  assert.equal(leida.LocalId, '  42 ');
  sinGsiVacio(leida);

  const sinLocal = {
    Id: 'PED-2026-00002',
    LocalId: '   ',
    Estado: 'Completado',
    Fecha: 'no-es-fecha',
    CompletadoEn: '2026-10-12T18:04:00.000Z',
    gsi_local: '',
  };
  aplicarClavesGsi(sinLocal, clavesPedido(sinLocal));
  const leidaSin = await guardar(tabla, sinLocal, { Id: sinLocal.Id });
  assert.equal(leidaSin.gsi_local, undefined);
  assert.equal(leidaSin.gsi_estado, 'Completado');
  assert.equal(leidaSin.gsi_fecha, '2026-10-12');
  sinGsiVacio(leidaSin);

  const values = { ':e': 'Enviado' };
  const fusion = fusionarClavesUpdate(
    'SET Estado = :e REMOVE CompletadoEn, CompletadoPor',
    values,
    clavesPedido({
      LocalId: '',
      Estado: 'Enviado',
      Fecha: '7/1/2026',
      CompletadoEn: '',
    }),
  );
  await docClient.send(new UpdateCommand({
    TableName: tabla,
    Key: { Id: sinLocal.Id },
    UpdateExpression: fusion.UpdateExpression,
    ExpressionAttributeValues: fusion.ExpressionAttributeValues,
  }));
  const trasUpdate = await docClient.send(new GetCommand({
    TableName: tabla,
    Key: { Id: sinLocal.Id },
  }));
  assert.equal(trasUpdate.Item.gsi_estado, 'Enviado');
  assert.equal(trasUpdate.Item.gsi_fecha, '2026-01-07');
  assert.equal(trasUpdate.Item.gsi_local, undefined);
  assert.equal(trasUpdate.Item.CompletadoEn, undefined);
  sinGsiVacio(trasUpdate.Item);
});

test('actuaciones: listado fijo, artista vacío omitido y fecha dd/mm/aaaa en la clave', async () => {
  const tabla = 't-actuaciones';
  memoria(tabla, 'id_actuacion');
  const hueco = {
    id_actuacion: 'a1',
    id_artista: '',
    fecha: '1/2/2026',
    hora_inicio: '22:00',
    gsi_artista: '',
  };
  aplicarClavesGsi(hueco, clavesActuacion(hueco));
  const leida = await guardar(tabla, hueco, { id_actuacion: 'a1' });
  assert.equal(leida.id_artista, '');
  assert.equal(leida.gsi_listado, 'ACTUACION');
  assert.equal(leida.gsi_artista, undefined);
  assert.equal(leida.gsi_fecha, '2026-02-01#22:00');
  sinGsiVacio(leida);

  const sinFecha = { id_actuacion: 'a2', id_artista: 'art-9', fecha: 'no', hora_inicio: '' };
  aplicarClavesGsi(sinFecha, clavesActuacion(sinFecha));
  const leidaMala = await guardar(tabla, sinFecha, { id_actuacion: 'a2' });
  assert.equal(leidaMala.gsi_listado, 'ACTUACION');
  assert.equal(leidaMala.gsi_artista, 'art-9');
  assert.equal(leidaMala.gsi_fecha, undefined);
  sinGsiVacio(leidaMala);
});

test('mystery guest: local y fecha de visita; local vacío no se escribe', async () => {
  const tabla = 't-mystery';
  memoria(tabla, 'id');
  const visita = { id: 'm1', LocalId: '000042', FechaDia: '2026-05-02', Fecha: '2026-05-02T10:00:00.000Z' };
  aplicarClavesGsi(visita, clavesMysteryGuest(visita));
  const leida = await guardar(tabla, visita, { id: 'm1' });
  assert.equal(leida.gsi_local, '000042');
  assert.equal(leida.gsi_fecha, '2026-05-02');
  sinGsiVacio(leida);

  const derivada = { id: 'm2', localId: 'L9', Fecha: '2026-06-01T22:15:00.000Z' };
  aplicarClavesGsi(derivada, clavesMysteryGuest(derivada));
  const leidaDerivada = await guardar(tabla, derivada, { id: 'm2' });
  assert.equal(leidaDerivada.gsi_local, 'L9');
  assert.equal(leidaDerivada.gsi_fecha, '2026-06-01');

  const sinLocal = { id: 'm3', LocalId: '  ', CreadoEn: 'no-fecha', gsi_local: '' };
  aplicarClavesGsi(sinLocal, clavesMysteryGuest(sinLocal));
  const leidaSin = await guardar(tabla, sinLocal, { id: 'm3' });
  assert.equal(leidaSin.gsi_local, undefined);
  assert.equal(leidaSin.gsi_fecha, undefined);
  sinGsiVacio(leidaSin);
});

test('mantenimiento: tipo y fecha de creación; ambos omitidos si no valen', async () => {
  const tabla = 't-mant';
  memoria(tabla, 'PK', 'SK');
  const creada = {
    PK: 'LOCAL#1',
    SK: 'INC#1',
    tipo: 'INC',
    fecha_creacion: '2026-04-03T08:00:00.000Z',
  };
  aplicarClavesGsi(creada, clavesMantenimiento(creada));
  const leida = await guardar(tabla, creada, { PK: creada.PK, SK: creada.SK });
  assert.equal(leida.gsi_tipo, 'INC');
  assert.equal(leida.gsi_fecha, '2026-04-03T08:00:00.000Z');
  sinGsiVacio(leida);

  const mala = { PK: 'LOCAL#1', SK: 'INC#x', tipo: '  ', fecha_creacion: 'ayer', gsi_tipo: '' };
  aplicarClavesGsi(mala, clavesMantenimiento(mala));
  const leidaMala = await guardar(tabla, mala, { PK: mala.PK, SK: mala.SK });
  assert.equal(leidaMala.gsi_tipo, undefined);
  assert.equal(leidaMala.gsi_fecha, undefined);
  sinGsiVacio(leidaMala);
});

test('negociaciones: gsi_listado solo en META y la fecha inválida no se escribe', async () => {
  const tabla = 't-neg';
  memoria(tabla, 'PK', 'SK');
  const meta = { PK: 'n1', SK: 'META', fecha: '2026-07-09' };
  aplicarClavesGsi(meta, clavesNegociacionMeta(meta));
  const leida = await guardar(tabla, meta, { PK: 'n1', SK: 'META' });
  assert.equal(leida.gsi_listado, 'NEG');
  assert.equal(leida.gsi_fecha, '2026-07-09');
  sinGsiVacio(leida);

  const linea = { PK: 'n1', SK: 'LINEA#1', fecha: '2026-07-09', gsi_listado: 'NEG', gsi_fecha: '' };
  omitirClavesGsi(linea);
  aplicarClavesGsi(linea, clavesNegociacionMeta(linea));
  const leidaLinea = await guardar(tabla, linea, { PK: 'n1', SK: 'LINEA#1' });
  assert.equal(leidaLinea.gsi_listado, undefined);
  assert.equal(leidaLinea.gsi_fecha, undefined);
  sinGsiVacio(leidaLinea);

  const sinFecha = { PK: 'n2', SK: 'META', fecha: '' };
  aplicarClavesGsi(sinFecha, clavesNegociacionMeta(sinFecha));
  const leidaSin = await guardar(tabla, sinFecha, { PK: 'n2', SK: 'META' });
  assert.equal(leidaSin.gsi_listado, 'NEG');
  assert.equal(leidaSin.gsi_fecha, undefined);
  sinGsiVacio(leidaSin);
});

test('acuerdos detalle: ProductId sin ceros a la izquierda y ausente si viene vacío', async () => {
  const tabla = 't-acuerdos-det';
  memoria(tabla, 'PK', 'SK');
  const det = { PK: 'ac1', SK: '000123', ProductId: '000123' };
  aplicarClavesGsi(det, clavesAcuerdoDetalle(det.ProductId));
  const leida = await guardar(tabla, det, { PK: 'ac1', SK: '000123' });
  assert.equal(leida.gsi_producto, '123');
  assert.equal(leida.ProductId, '000123');
  sinGsiVacio(leida);

  const ceros = { PK: 'ac1', SK: '000', ProductId: '000' };
  aplicarClavesGsi(ceros, clavesAcuerdoDetalle(ceros.ProductId));
  const leidaCeros = await guardar(tabla, ceros, { PK: 'ac1', SK: '000' });
  assert.equal(leidaCeros.gsi_producto, '0');

  const vacio = { PK: 'ac1', SK: 'x', ProductId: '  ', gsi_producto: '' };
  aplicarClavesGsi(vacio, clavesAcuerdoDetalle(vacio.ProductId));
  const leidaVacio = await guardar(tabla, vacio, { PK: 'ac1', SK: 'x' });
  assert.equal(leidaVacio.gsi_producto, undefined);
  sinGsiVacio(leidaVacio);
});

test('refacturaciones: estado y creado_en; fecha inválida no se escribe', async () => {
  const tabla = 't-refact';
  memoria(tabla, 'PK', 'SK');
  const linea = {
    PK: 'SOCIEDAD#1',
    SK: 'LINEA#1',
    estado: 'pendiente',
    creado_en: '2026-08-01T09:30:00.000Z',
  };
  aplicarClavesGsi(linea, clavesRefacturacion(linea));
  const leida = await guardar(tabla, linea, { PK: linea.PK, SK: linea.SK });
  assert.equal(leida.gsi_estado, 'pendiente');
  assert.equal(leida.gsi_fecha, '2026-08-01T09:30:00.000Z');
  sinGsiVacio(leida);

  const marcada = { ...leida, estado: 'refacturada', factura_numero: '' };
  aplicarClavesGsi(marcada, clavesRefacturacion(marcada));
  const leidaMarcada = await guardar(tabla, marcada, { PK: linea.PK, SK: linea.SK });
  assert.equal(leidaMarcada.gsi_estado, 'refacturada');
  assert.equal(leidaMarcada.factura_numero, '');
  sinGsiVacio(leidaMarcada);

  const mala = { PK: 'SOCIEDAD#2', SK: 'LINEA#2', estado: '', creado_en: 'mañana', gsi_estado: '' };
  aplicarClavesGsi(mala, clavesRefacturacion(mala));
  const leidaMala = await guardar(tabla, mala, { PK: mala.PK, SK: mala.SK });
  assert.equal(leidaMala.gsi_estado, undefined);
  assert.equal(leidaMala.gsi_fecha, undefined);
  sinGsiVacio(leidaMala);
});

test('banca: la carga lleva CARGA y el movimiento el hash; ambos omiten el vacío', async () => {
  const ficheros = 't-bank-files';
  const movimientos = 't-bank-mov';
  const db = crearDynamoMemoria();
  db.crearTabla(ficheros, { hashKey: 'hashFichero' });
  db.crearTabla(movimientos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);

  const carga = { hashFichero: 'abc', importadoEn: '2026-09-02T11:00:00.000Z' };
  aplicarClavesGsi(carga, clavesFicheroBanca(carga));
  const leida = await guardar(ficheros, carga, { hashFichero: 'abc' });
  assert.equal(leida.gsi_listado, 'CARGA');
  assert.equal(leida.gsi_fecha, '2026-09-02T11:00:00.000Z');
  sinGsiVacio(leida);

  const cargaMala = { hashFichero: 'def', importadoEn: '', gsi_fecha: '' };
  aplicarClavesGsi(cargaMala, clavesFicheroBanca(cargaMala));
  const leidaMala = await guardar(ficheros, cargaMala, { hashFichero: 'def' });
  assert.equal(leidaMala.gsi_listado, 'CARGA');
  assert.equal(leidaMala.gsi_fecha, undefined);
  sinGsiVacio(leidaMala);

  const mov = { PK: 'ACCOUNT#1', SK: 'TXN#1', hashFichero: 'abc' };
  aplicarClavesGsi(mov, clavesMovimientoBanca(mov.hashFichero));
  const leidoMov = await guardar(movimientos, mov, { PK: mov.PK, SK: mov.SK });
  assert.equal(leidoMov.gsi_fichero, 'abc');
  sinGsiVacio(leidoMov);

  const movVacio = { PK: 'ACCOUNT#1', SK: 'TXN#2', hashFichero: '  ', gsi_fichero: '' };
  aplicarClavesGsi(movVacio, clavesMovimientoBanca(movVacio.hashFichero));
  const leidoVacio = await guardar(movimientos, movVacio, { PK: movVacio.PK, SK: movVacio.SK });
  assert.equal(leidoVacio.gsi_fichero, undefined);
  sinGsiVacio(leidoVacio);
});
