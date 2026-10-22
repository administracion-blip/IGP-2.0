/**
 * Lecturas y escrituras en lote (`lib/dynamo/lotes.js`).
 *
 * Lo que se fija: el troceo respeta los límites del servicio (100 claves por
 * BatchGet, 25 ítems por BatchWrite), las claves repetidas se piden una vez, lo
 * que DynamoDB deja sin procesar se reintenta con backoff y, si tras el máximo
 * sigue quedando algo, se lanza un error con lo pendiente en vez de devolver un
 * resultado parcial como si fuera completo.
 */

import test, { beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  batchGetTodos,
  batchWriteTodos,
  indexarPor,
  esperaBackoff,
  fijarEsperaReintentos,
  MAX_INTENTOS_LOTE,
} = await import('../lib/dynamo/lotes.js');

const TABLA = 'Igp_PruebaLotes';

let db;
/** Esperas pedidas entre reintentos (ms), sin dormir de verdad. */
let esperas;
const esperar = async (ms) => {
  esperas.push(ms);
};

beforeEach(() => {
  db = crearDynamoMemoria();
  db.crearTabla(TABLA, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  esperas = [];
});

function sembrar(n) {
  for (let i = 0; i < n; i += 1) db.sembrar(TABLA, { PK: 'P', SK: `S${i}`, valor: i, extra: 'x' });
}

const clave = (i) => ({ PK: 'P', SK: `S${i}` });

/**
 * Envuelve el doble para que las primeras `veces` peticiones del tipo dado
 * devuelvan sin procesar la segunda mitad de lo pedido (lo que hace DynamoDB con
 * throttling). `veces = Infinity` simula un throttling que no cesa.
 */
function conSinProcesar(tipo, veces) {
  const enviar = docClient.send;
  const llamadas = [];
  docClient.send = async (cmd) => {
    if (cmd?.constructor?.name !== tipo) return enviar(cmd);
    llamadas.push(cmd.input);
    if (llamadas.length > veces) return enviar(cmd);
    if (tipo === 'BatchGetCommand') {
      const pet = cmd.input.RequestItems[TABLA];
      const mitad = Math.ceil(pet.Keys.length / 2);
      const procesadas = pet.Keys.slice(0, mitad);
      const r = procesadas.length
        ? await enviar({ constructor: cmd.constructor, input: { RequestItems: { [TABLA]: { ...pet, Keys: procesadas } } } })
        : { Responses: { [TABLA]: [] } };
      const resto = pet.Keys.slice(mitad);
      return { Responses: r.Responses, UnprocessedKeys: resto.length ? { [TABLA]: { ...pet, Keys: resto } } : {} };
    }
    const pet = cmd.input.RequestItems[TABLA];
    const mitad = Math.ceil(pet.length / 2);
    if (mitad > 0) await enviar({ constructor: cmd.constructor, input: { RequestItems: { [TABLA]: pet.slice(0, mitad) } } });
    const resto = pet.slice(mitad);
    return { UnprocessedItems: resto.length ? { [TABLA]: resto } : {} };
  };
  return llamadas;
}

/** Throttling total: nunca procesa nada. */
function siempreSinProcesar(tipo) {
  const llamadas = [];
  docClient.send = async (cmd) => {
    llamadas.push(cmd.input);
    const pet = cmd.input.RequestItems[TABLA];
    if (tipo === 'BatchGetCommand') return { Responses: { [TABLA]: [] }, UnprocessedKeys: { [TABLA]: pet } };
    return { UnprocessedItems: { [TABLA]: pet } };
  };
  return llamadas;
}

// ─── BatchGet ───

test('batchGetTodos trocea en bloques de 100 y devuelve todo lo que existe', async () => {
  sembrar(250);
  const items = await batchGetTodos(TABLA, Array.from({ length: 250 }, (_, i) => clave(i)), { esperar });
  assert.equal(items.length, 250);
  const lotes = db.operaciones.filter((o) => o.tipo === 'BatchGetCommand').map((o) => o.claves);
  assert.deepEqual(lotes, [100, 100, 50]);
});

test('batchGetTodos pide una sola vez cada clave repetida (sin importar el orden de atributos)', async () => {
  sembrar(3);
  const claves = [clave(0), clave(1), { SK: 'S0', PK: 'P' }, clave(1), clave(2)];
  const items = await batchGetTodos(TABLA, claves, { esperar });
  assert.equal(items.length, 3);
  assert.deepEqual(db.operaciones.filter((o) => o.tipo === 'BatchGetCommand').map((o) => o.claves), [3]);
});

test('batchGetTodos: las claves inexistentes no vuelven y sin claves no hay petición', async () => {
  sembrar(2);
  const items = await batchGetTodos(TABLA, [clave(0), clave(99)], { esperar });
  assert.deepEqual(items.map((it) => it.SK), ['S0']);
  assert.deepEqual(await batchGetTodos(TABLA, [], { esperar }), []);
  assert.equal(db.operaciones.filter((o) => o.tipo === 'BatchGetCommand').length, 1);
});

test('batchGetTodos aplica la proyección y los nombres de atributo', async () => {
  sembrar(2);
  const items = await batchGetTodos(TABLA, [clave(0), clave(1)], {
    projection: '#sk, #v',
    expressionAttributeNames: { '#sk': 'SK', '#v': 'valor' },
    esperar,
  });
  assert.deepEqual(items.sort((a, b) => a.valor - b.valor), [{ SK: 'S0', valor: 0 }, { SK: 'S1', valor: 1 }]);
});

test('batchGetTodos reintenta las claves sin procesar con backoff creciente hasta completarlas', async () => {
  sembrar(8);
  const llamadas = conSinProcesar('BatchGetCommand', 2);
  const items = await batchGetTodos(TABLA, Array.from({ length: 8 }, (_, i) => clave(i)), { esperar });
  assert.equal(items.length, 8);
  // 8 claves → 4 sin procesar → 2 sin procesar → la tercera las lee todas.
  assert.deepEqual(llamadas.map((c) => c.RequestItems[TABLA].Keys.length), [8, 4, 2]);
  assert.equal(esperas.length, 2);
  assert.ok(esperas[0] >= 25 && esperas[0] <= 50, `primera espera ${esperas[0]}`);
  assert.ok(esperas[1] >= 50 && esperas[1] <= 100, `segunda espera ${esperas[1]}`);
});

test('batchGetTodos lanza con las claves pendientes si se agota el máximo de intentos', async () => {
  const llamadas = siempreSinProcesar('BatchGetCommand');
  await assert.rejects(
    batchGetTodos(TABLA, [clave(0), clave(1)], { esperar, maxIntentos: 4 }),
    (err) => {
      assert.match(err.message, /sin leer tras 4 intentos/);
      assert.deepEqual(err.pendientes, [clave(0), clave(1)]);
      return true;
    },
  );
  assert.equal(llamadas.length, 4);
  assert.equal(esperas.length, 3);
});

test('el máximo de intentos por defecto es 8', async () => {
  const llamadas = siempreSinProcesar('BatchGetCommand');
  await assert.rejects(batchGetTodos(TABLA, [clave(0)], { esperar }));
  assert.equal(MAX_INTENTOS_LOTE, 8);
  assert.equal(llamadas.length, 8);
});

test('el orden de la respuesta es indiferente: indexarPor encuentra cada ítem por su clave', async () => {
  sembrar(5);
  const enviar = docClient.send;
  docClient.send = async (cmd) => {
    const r = await enviar(cmd);
    if (r.Responses?.[TABLA]) r.Responses[TABLA].reverse();
    return r;
  };
  const items = await batchGetTodos(TABLA, [clave(0), clave(1), clave(2), clave(3), clave(4)], { esperar });
  assert.equal(items[0].SK, 'S4', 'la respuesta llega desordenada');
  const porSk = indexarPor(items, (it) => it.SK);
  for (let i = 0; i < 5; i += 1) assert.equal(porSk.get(`S${i}`).valor, i);
});

// ─── BatchWrite ───

const itemNuevo = (i) => ({ PK: 'N', SK: `I${String(i).padStart(3, '0')}`, n: i });

test('batchWriteTodos trocea en bloques de 25 y escribe todo', async () => {
  await batchWriteTodos(TABLA, Array.from({ length: 60 }, (_, i) => itemNuevo(i)), { esperar });
  assert.equal(db.listar(TABLA).length, 60);
  const lotes = db.operaciones.filter((o) => o.tipo === 'BatchWriteCommand').map((o) => o.peticiones);
  assert.deepEqual(lotes, [25, 25, 10]);
});

test('batchWriteTodos sin ítems no hace ninguna petición', async () => {
  await batchWriteTodos(TABLA, [], { esperar });
  assert.equal(db.operaciones.length, 0);
});

test('batchWriteTodos reintenta los ítems sin procesar hasta escribirlos todos', async () => {
  const llamadas = conSinProcesar('BatchWriteCommand', 3);
  await batchWriteTodos(TABLA, Array.from({ length: 10 }, (_, i) => itemNuevo(i)), { esperar });
  assert.equal(db.listar(TABLA).length, 10);
  assert.deepEqual(llamadas.map((c) => c.RequestItems[TABLA].length), [10, 5, 2, 1]);
  assert.equal(esperas.length, 3);
});

test('batchWriteTodos lanza con los pendientes del bloque y de los bloques siguientes', async () => {
  // El primer bloque se escribe; el segundo queda a medias para siempre.
  const enviar = docClient.send;
  let n = 0;
  docClient.send = async (cmd) => {
    n += 1;
    if (n === 1) return enviar(cmd);
    const pet = cmd.input.RequestItems[TABLA];
    if (n === 2) {
      await enviar({ constructor: cmd.constructor, input: { RequestItems: { [TABLA]: pet.slice(0, 20) } } });
      return { UnprocessedItems: { [TABLA]: pet.slice(20) } };
    }
    return { UnprocessedItems: { [TABLA]: pet } };
  };
  const items = Array.from({ length: 60 }, (_, i) => itemNuevo(i));
  await assert.rejects(batchWriteTodos(TABLA, items, { esperar, maxIntentos: 3 }), (err) => {
    assert.match(err.message, /5 ítems sin escribir tras 3 intentos/);
    // 5 del segundo bloque + los 10 del tercero, que ni se intentaron.
    assert.deepEqual(err.pendientes.map((it) => it.n), [45, 46, 47, 48, 49, ...Array.from({ length: 10 }, (_, i) => 50 + i)]);
    return true;
  });
  assert.equal(db.listar(TABLA).length, 45);
  assert.equal(esperas.length, 2);
});

test('batchWriteTodos: si la petición falla, el error lleva los pendientes', async () => {
  const enviar = docClient.send;
  let n = 0;
  docClient.send = async (cmd) => {
    n += 1;
    if (n === 1) return enviar(cmd);
    throw Object.assign(new Error('Throughput exceeded'), { name: 'ProvisionedThroughputExceededException' });
  };
  const items = Array.from({ length: 30 }, (_, i) => itemNuevo(i));
  await assert.rejects(batchWriteTodos(TABLA, items, { esperar }), (err) => {
    assert.equal(err.name, 'ProvisionedThroughputExceededException');
    assert.deepEqual(err.pendientes.map((it) => it.n), [25, 26, 27, 28, 29]);
    return true;
  });
});

// ─── Espera ───

test('esperaBackoff: 50 ms · 2^n con jitter entre la mitad y el tope', () => {
  for (let n = 0; n < 8; n += 1) {
    const tope = 50 * 2 ** n;
    for (let k = 0; k < 20; k += 1) {
      const ms = esperaBackoff(n);
      assert.ok(ms >= tope / 2 && ms <= tope, `n=${n}: ${ms}`);
    }
  }
});

test('fijarEsperaReintentos sustituye la espera por defecto y se puede restaurar', async () => {
  const restaurar = fijarEsperaReintentos(esperar);
  try {
    siempreSinProcesar('BatchWriteCommand');
    await assert.rejects(batchWriteTodos(TABLA, [itemNuevo(1)], { maxIntentos: 3 }));
    assert.equal(esperas.length, 2);
  } finally {
    restaurar();
  }
});
