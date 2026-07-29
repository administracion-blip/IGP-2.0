/**
 * Permisos de escritura de los ajustes de facturación.
 *
 * El CRUD de `Igp_Ajustes` lo usa cualquier usuario autenticado para cosas suyas
 * (los favoritos se guardan por ahí), así que la protección va por clave y no por
 * ruta. Lo que se comprueba aquí es que cubre **todos** los ítems de la
 * facturación periódica, cerrojos incluidos: un cerrojo escrito a mano con
 * caducidad lejana deja la facturación mensual muerta, porque la adquisición
 * devuelve 409 mientras exista y el trabajo programado se salta los ciclos en
 * silencio.
 *
 * Y al revés: la protección no puede pasarse de ancha. Los ajustes de cualquier
 * usuario tienen que seguir escribiéndose sin permisos especiales.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-ajustes';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { default: ajustesRouter } = await import('../routes/ajustes.js');

/** Administrador: `hasPermission` lo da por bueno sin leer la tabla de permisos. */
const ADMIN = { email: 'jefe@grupo.test', rol: 'Administrador' };
/** Usuario sin ningún permiso concedido: el que la protección debe frenar. */
const CAMARERO = { email: 'camarero@grupo.test', rol: 'Camarero' };

let usuarioActual = ADMIN;
let servidor = null;
let base = '';

/** `usuario: null` simula la petición sin sesión; omitirlo usa el administrador. */
async function api(metodo, ruta, cuerpo, usuario = ADMIN) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', ajustesRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

function escenario() {
  const db = montarEscenario();
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  return db;
}

// ─── Los cerrojos son tan sensibles como el interruptor ───

const CERROJOS = [
  ['compras', 'facturacion_lock'],
  ['compras', 'facturacion_rappel_lock'],
  ['mantenimiento', 'facturacion_lock'],
];

for (const [pk, sk] of CERROJOS) {
  test(`sin permiso no se puede crear el cerrojo ${pk}/${sk}`, async () => {
    const db = escenario();
    const dentroDeUnAnio = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const r = await api('POST', '/api/ajustes', { PK: pk, SK: sk, expira_en: dentroDeUnAnio }, CAMARERO);
    assert.equal(r.status, 403);
    assert.equal(
      db.obtener(tables.ajustes, { PK: pk, SK: sk }),
      null,
      'un cerrojo con caducidad lejana dejaría la facturación mensual muerta'
    );
  });

  test(`sin permiso no se puede borrar el cerrojo ${pk}/${sk}`, async () => {
    const db = escenario();
    db.sembrar(tables.ajustes, { PK: pk, SK: sk, ejecucion: 'en-marcha', expira_en: '2099-01-01T00:00:00.000Z' });

    const r = await api('DELETE', `/api/ajustes/${pk}/${sk}`, undefined, CAMARERO);
    assert.equal(r.status, 403);
    assert.ok(
      db.obtener(tables.ajustes, { PK: pk, SK: sk }),
      'borrarlo a media tanda aborta la generación en curso'
    );
  });

  test(`sin permiso no se puede alargar el cerrojo ${pk}/${sk}`, async () => {
    const db = escenario();
    db.sembrar(tables.ajustes, { PK: pk, SK: sk, expira_en: '2026-01-01T00:00:00.000Z' });

    const r = await api('PATCH', `/api/ajustes/${pk}/${sk}`, { expira_en: '2099-01-01T00:00:00.000Z' }, CAMARERO);
    assert.equal(r.status, 403);
    assert.equal(db.obtener(tables.ajustes, { PK: pk, SK: sk }).expira_en, '2026-01-01T00:00:00.000Z');
  });
}

test('el interruptor de la facturación sigue protegido', async () => {
  const db = escenario();
  const r = await api('PATCH', '/api/ajustes/compras/facturacion', { Enabled: true }, CAMARERO);
  assert.equal(r.status, 403);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }), null);
});

test('con el permiso, el interruptor y el cerrojo se escriben con normalidad', async () => {
  const db = escenario();

  const ajuste = await api('POST', '/api/ajustes', { PK: 'compras', SK: 'facturacion', Enabled: true }, ADMIN);
  assert.equal(ajuste.status, 200);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }).Enabled, true);

  const cerrojo = await api('DELETE', '/api/ajustes/compras/facturacion_lock', undefined, ADMIN);
  assert.equal(cerrojo.status, 200, 'un cerrojo atascado se tiene que poder soltar a mano');
});

// ─── La protección no puede pasarse de ancha ───

test('los ajustes de cualquier usuario se siguen escribiendo sin permisos especiales', async () => {
  const db = escenario();

  // Favoritos: es el caso que impide proteger la ruta entera con un middleware.
  const favoritos = await api('PATCH', '/api/ajustes/favoritos/1', { Rutas: ['/cajas'] }, CAMARERO);
  assert.equal(favoritos.status, 200);
  assert.deepEqual(db.obtener(tables.ajustes, { PK: 'favoritos', SK: '1' }).Rutas, ['/cajas']);

  const personalizacion = await api('POST', '/api/ajustes', { PK: 'personalizacion', SK: 'app', Tema: 'claro' }, CAMARERO);
  assert.equal(personalizacion.status, 200);
});

test('otros ítems bajo los mismos PK que no son de facturación quedan libres', async () => {
  // El prefijo es `facturacion`, no el PK entero: si mañana `compras` guarda un
  // ajuste de otra cosa, no debe pedir el permiso de facturar.
  const otro = await api('POST', '/api/ajustes', { PK: 'compras', SK: 'preferencias_tabla', Columnas: [] }, CAMARERO);
  assert.equal(otro.status, 200);

  const deMantenimiento = await api('PATCH', '/api/ajustes/mantenimiento/tarifas', { Precio: 30 }, CAMARERO);
  assert.equal(deMantenimiento.status, 200);
});

test('un usuario no autenticado no puede tocar el cerrojo', async () => {
  const db = escenario();
  const r = await api('POST', '/api/ajustes', { PK: 'compras', SK: 'facturacion_lock' }, null);
  assert.equal(r.status, 401);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion_lock' }), null);
});
