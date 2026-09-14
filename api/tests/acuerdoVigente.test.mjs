/**
 * resolveAcuerdoVigenteProducto: botellas restantes del ganador.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { docClient, tables } from '../lib/db.js';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';
import { resolveAcuerdoVigenteProducto } from '../lib/mayorista/acuerdoVigente.js';

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.acuerdos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.acuerdosDetalles, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.comprasProveedor, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

function sembrarAcuerdo(db, { pk, marca = 'Marca', inicio, fin, estado = 'Activo' }) {
  db.sembrar(tables.acuerdos, {
    PK: pk,
    SK: 'META',
    Estado: estado,
    Marca: marca,
    FechaInicio: inicio,
    FechaFin: fin,
  });
}

function sembrarDetalle(db, { pk, productId, cantidad, aportacion = 0, rappel = 0 }) {
  db.sembrar(tables.acuerdosDetalles, {
    PK: pk,
    SK: productId,
    ProductId: productId,
    Cantidad: cantidad,
    Aportacion: aportacion,
    Rappel: rappel,
    DescuentoExtra: 0,
  });
}

function sembrarCompra(db, { pk, productId, fecha, quantity }) {
  db.sembrar(tables.comprasProveedor, {
    PK: pk,
    SK: `L#${pk}`,
    ProductId: productId,
    AlbaranFecha: fecha,
    Quantity: quantity,
  });
}

const VACIO = {
  vigente: false,
  aportacion_unitaria: 0,
  acuerdo_id: null,
  acuerdo_fecha_fin: null,
  acuerdo_marca: null,
  botellas_restantes: null,
  botellas_acordadas: null,
};

test('sin producto o fecha → vacio con botellas null', async () => {
  montar();
  assert.deepEqual(await resolveAcuerdoVigenteProducto('', '2026-02-15'), VACIO);
  assert.deepEqual(await resolveAcuerdoVigenteProducto('P1', ''), VACIO);
});

test('sin acuerdo vigente → botellas null', async () => {
  montar();
  assert.deepEqual(await resolveAcuerdoVigenteProducto('P1', '2026-02-15'), VACIO);
});

test('vigente: restantes = acordado - compradas del ganador', async () => {
  const db = montar();
  sembrarAcuerdo(db, { pk: 'ACU-A', inicio: '2026-01-01', fin: '2026-12-31' });
  sembrarDetalle(db, { pk: 'ACU-A', productId: 'P1', cantidad: 100, aportacion: 5 });
  sembrarCompra(db, { pk: 'C1', productId: 'P1', fecha: '2026-02-10', quantity: 30 });
  sembrarCompra(db, { pk: 'C2', productId: 'P1', fecha: '2026-03-01', quantity: 10 });

  assert.deepEqual(await resolveAcuerdoVigenteProducto('P1', '2026-02-15'), {
    vigente: true,
    aportacion_unitaria: 5,
    acuerdo_id: 'ACU-A',
    acuerdo_fecha_fin: '2026-12-31',
    acuerdo_marca: 'Marca',
    botellas_acordadas: 100,
    botellas_restantes: 60,
  });
});

test('vigente: restantes puede ser negativo si se pasa de cupo', async () => {
  const db = montar();
  sembrarAcuerdo(db, { pk: 'ACU-A', inicio: '2026-01-01', fin: '2026-12-31' });
  sembrarDetalle(db, { pk: 'ACU-A', productId: 'P1', cantidad: 10, aportacion: 3 });
  sembrarCompra(db, { pk: 'C1', productId: 'P1', fecha: '2026-02-10', quantity: 15 });

  const r = await resolveAcuerdoVigenteProducto('P1', '2026-02-15');
  assert.equal(r.botellas_acordadas, 10);
  assert.equal(r.botellas_restantes, -5);
});

test('solo cuenta compras del ganador (rango del de mayor aportación)', async () => {
  const db = montar();
  sembrarAcuerdo(db, { pk: 'ACU-BAJO', inicio: '2026-02-01', fin: '2026-02-28', marca: 'Baja' });
  sembrarDetalle(db, { pk: 'ACU-BAJO', productId: 'P1', cantidad: 100, aportacion: 2 });
  sembrarAcuerdo(db, { pk: 'ACU-ALTO', inicio: '2026-01-01', fin: '2026-12-31', marca: 'Alta' });
  sembrarDetalle(db, { pk: 'ACU-ALTO', productId: 'P1', cantidad: 50, aportacion: 10 });
  sembrarCompra(db, { pk: 'C-ENE', productId: 'P1', fecha: '2026-01-10', quantity: 12 });
  sembrarCompra(db, { pk: 'C-FEB', productId: 'P1', fecha: '2026-02-10', quantity: 8 });

  const r = await resolveAcuerdoVigenteProducto('P1', '2026-02-15');
  assert.equal(r.acuerdo_id, 'ACU-ALTO');
  assert.equal(r.botellas_acordadas, 50);
  assert.equal(r.botellas_restantes, 30);
});
