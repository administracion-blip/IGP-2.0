/**
 * Contador de etiquetas: ADD atómico y altas que no comparten número.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { docClient, tables } from '../lib/db.js';
import { crearDynamoMemoria } from './dynamoMemoria.mjs';
import { reservarCorrelativo } from '../lib/activos/store.js';
import { crearActivo, crearCategoria, crearModelo } from '../lib/activos/servicio.js';

const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador', nombre: 'Jefe' };
const CAT_ID = '11111111-1111-4111-8111-111111111111';

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.activosCatalogo, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'nombre' },
      'Categoria-index': { hashKey: 'categoria_id', rangeKey: 'nombre' },
      'Marca-index': { hashKey: 'marca_norm', rangeKey: 'nombre' },
    },
  });
  db.crearTabla(tables.activos, {
    hashKey: 'asset_id',
    indices: {
      'CentroEstado-index': { hashKey: 'id_local', rangeKey: 'gsi_estado_cat_etiqueta' },
      'Modelo-index': { hashKey: 'modelo_id', rangeKey: 'etiqueta_legible' },
      'Etiqueta-index': { hashKey: 'prefijo_etiqueta', rangeKey: 'etiqueta_legible' },
      'Serie-index': { hashKey: 'numero_serie_norm', rangeKey: 'asset_id' },
      'PendienteVerificacion-index': { hashKey: 'id_local', rangeKey: 'creado_en' },
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'actualizado_en' },
    },
  });
  db.crearTabla(tables.activosEventos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.activosContadores, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.locales, { hashKey: 'id_Locales' });
  db.sembrar(tables.locales, { id_Locales: '000012', nombre: 'Paripe' });
  db.instalar(docClient);
  return db;
}

test('reservarCorrelativo: 20 reservas seguidas son 1..20 sin huecos ni repetición', async () => {
  montar();
  const vistos = [];
  for (let i = 0; i < 20; i += 1) {
    vistos.push(await reservarCorrelativo(CAT_ID));
  }
  assert.deepEqual(vistos, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('reservarCorrelativo en paralelo no entrega el mismo número', async () => {
  montar();
  const n = 12;
  const vistos = await Promise.all(Array.from({ length: n }, () => reservarCorrelativo(CAT_ID)));
  assert.equal(new Set(vistos).size, n, `números repetidos: ${vistos.join(',')}`);
  assert.equal(Math.max(...vistos), n);
});

test('dos altas del mismo modelo no comparten etiqueta', async () => {
  montar();
  const cat = await crearCategoria(ADMIN, {
    nombre: 'PDA',
    prefijo_etiqueta: 'PDA',
    formato_etiqueta: 'completa',
  });
  const modelo = await crearModelo(ADMIN, {
    categoria_id: cat.categoria_id,
    marca: 'Sunmi',
    nombre: 'L2K',
    es_serializable: true,
  });
  const [a, b] = await Promise.all([
    crearActivo(ADMIN, { modelo_id: modelo.modelo_id, id_local: '12', numero_serie: 'AAA' }),
    crearActivo(ADMIN, { modelo_id: modelo.modelo_id, id_local: '12', numero_serie: 'BBB' }),
  ]);
  assert.notEqual(a.asset_id, b.asset_id);
  assert.notEqual(a.etiqueta_legible, b.etiqueta_legible);
  assert.match(a.etiqueta_legible, /^PDA-\d+$/);
  assert.match(b.etiqueta_legible, /^PDA-\d+$/);
});
