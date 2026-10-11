/**
 * Política de acceso del CRUD genérico de `Igp_Ajustes`.
 *
 * Cada clave se lee y se escribe con el permiso de la pantalla que la usa
 * (`api/lib/ajustes/politica.js`). Lo que se comprueba aquí:
 *
 * - Las claves de estado interno (cerrojos de la facturación periódica, hash del
 *   token ICS de cada usuario, secuencias…) quedan cerradas al router genérico,
 *   también para el Administrador: un cerrojo escrito a mano con caducidad lejana
 *   deja la facturación mensual muerta y el hash del token ICS de otro usuario da
 *   acceso a su calendario. Responden 404 para no revelar que existen.
 * - Los favoritos son de cada usuario: solo los suyos.
 * - Las pantallas que ya funcionaban siguen funcionando con su permiso.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-ajustes';

const { montarEscenario, tables } = await import('./escenarioFacturacion.mjs');
const { default: ajustesRouter } = await import('../routes/ajustes.js');

/** Administrador: `hasPermission` lo da por bueno sin leer la tabla de permisos. */
const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
/** Usuario sin ningún permiso concedido: el que la protección debe frenar. */
const CAMARERO = { sub: '000009', email: 'camarero@grupo.test', rol: 'Camarero' };
const RRHH = { sub: '000020', email: 'rrhh@grupo.test', rol: 'Administracion' };
const FACTURADOR = { sub: '000021', email: 'facturador@grupo.test', rol: 'Facturador' };
const ENCARGADO = { sub: '000022', email: 'encargado@grupo.test', rol: 'Local' };

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
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Administracion', SK: 'PERMISO#rrhh.horas' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Facturador', SK: 'PERMISO#compras.facturar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Facturador', SK: 'PERMISO#mantenimiento.facturar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#pedidos.preparar' });
  db.sembrar(tables.rolesPermisos, { PK: 'ROL#Local', SK: 'PERMISO#ajustes.sincronizaciones.empleados' });
  return db;
}

// ─── Claves cerradas: ni el Administrador por el router genérico ───

const CERRADAS = [
  ['compras', 'facturacion_lock'],
  ['compras', 'facturacion_rappel_lock'],
  ['mantenimiento', 'facturacion_lock'],
  ['tareas', 'ics_token#000002'],
  ['tareas', 'calendar_pull#000002#primary'],
  ['tareas', 'avisos_vencimiento_cerrojo'],
  ['mayorista', 'secuencia'],
  ['proyectos', 'enlaces'],
];

for (const [pk, sk] of CERRADAS) {
  const ruta = `/api/ajustes/${encodeURIComponent(pk)}/${encodeURIComponent(sk)}`;

  for (const [nombre, usuario] of [['sin permisos', CAMARERO], ['Administrador', ADMIN]]) {
    test(`${nombre}: ${pk}/${sk} no se lee ni se escribe por el router genérico`, async () => {
      const db = escenario();
      const original = { PK: pk, SK: sk, valor: 'interno', expira_en: '2026-01-01T00:00:00.000Z' };
      db.sembrar(tables.ajustes, original);

      const leer = await api('GET', ruta, undefined, usuario);
      assert.equal(leer.status, 404);
      assert.equal(leer.body.item, undefined);

      const crear = await api('POST', '/api/ajustes', { PK: pk, SK: sk, expira_en: '2099-01-01T00:00:00.000Z' }, usuario);
      assert.equal(crear.status, 404);
      const parchear = await api('PATCH', ruta, { expira_en: '2099-01-01T00:00:00.000Z' }, usuario);
      assert.equal(parchear.status, 404);
      const borrar = await api('DELETE', ruta, undefined, usuario);
      assert.equal(borrar.status, 404);

      assert.deepEqual(db.obtener(tables.ajustes, { PK: pk, SK: sk }), original);
    });
  }
}

test('cualquier SK con "lock" o "cerrojo" queda cerrada aunque no esté en la lista', async () => {
  escenario();
  assert.equal((await api('POST', '/api/ajustes', { PK: 'nuevo', SK: 'algo_lock' }, ADMIN)).status, 404);
  assert.equal((await api('POST', '/api/ajustes', { PK: 'nuevo', SK: 'Cerrojo_x' }, ADMIN)).status, 404);
});

test('el hash del token ICS de otro usuario no sale por la lectura por categoría', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'tareas', SK: 'ics_token#000002', hash: 'secreto' });
  db.sembrar(tables.ajustes, { PK: 'tareas', SK: 'avisos_vencimiento', Enabled: true });

  const camarero = await api('GET', '/api/ajustes?categoria=tareas', undefined, CAMARERO);
  assert.equal(camarero.status, 200);
  assert.deepEqual(camarero.body.items, []);

  const admin = await api('GET', '/api/ajustes?categoria=tareas', undefined, ADMIN);
  assert.deepEqual(admin.body.items.map((i) => i.SK), ['avisos_vencimiento']);
});

test('el listado completo sin categoría es solo del Administrador y nunca incluye claves cerradas', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'tareas', SK: 'ics_token#000002', hash: 'secreto' });
  db.sembrar(tables.ajustes, { PK: 'personalizacion', SK: 'app', PorcentajeBeneficio: 10 });

  const camarero = await api('GET', '/api/ajustes', undefined, CAMARERO);
  assert.equal(camarero.status, 403);
  assert.equal(camarero.body.error, 'No tienes permiso para este ajuste');

  const admin = await api('GET', '/api/ajustes', undefined, ADMIN);
  assert.equal(admin.status, 200);
  assert.deepEqual(admin.body.items.map((i) => `${i.PK}/${i.SK}`), ['personalizacion/app']);
});

// ─── Personalización y claves sin regla ───

test('sin permisos no se lee ni se escribe personalizacion/app', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'personalizacion', SK: 'app', PorcentajeBeneficio: 10, ImporteHoraDefecto: 15 });

  const leer = await api('GET', '/api/ajustes/personalizacion/app', undefined, CAMARERO);
  assert.equal(leer.status, 403);
  assert.equal(leer.body.item, undefined);

  const escribir = await api('POST', '/api/ajustes', { PK: 'personalizacion', SK: 'app', PorcentajeBeneficio: 90 }, CAMARERO);
  assert.equal(escribir.status, 403);
  assert.equal(db.obtener(tables.ajustes, { PK: 'personalizacion', SK: 'app' }).PorcentajeBeneficio, 10);
});

test('el % de beneficio lo leen las pantallas de pedidos (almacén incluido), pero no lo cambian', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'personalizacion', SK: 'app', PorcentajeBeneficio: 10 });

  const leer = await api('GET', '/api/ajustes/personalizacion/app', undefined, ENCARGADO);
  assert.equal(leer.status, 200);
  assert.equal(leer.body.item.PorcentajeBeneficio, 10);

  const escribir = await api('PATCH', '/api/ajustes/personalizacion/app', { PorcentajeBeneficio: 0 }, ENCARGADO);
  assert.equal(escribir.status, 403);
});

test('las claves sin regla propia solo las toca el Administrador', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'IA', SK: 'CONFIG', modelo: 'caro' });

  assert.equal((await api('GET', '/api/ajustes/IA/CONFIG', undefined, RRHH)).status, 403);
  assert.equal((await api('PATCH', '/api/ajustes/IA/CONFIG', { modelo: 'otro' }, RRHH)).status, 403);
  assert.equal((await api('POST', '/api/ajustes', { PK: 'compras', SK: 'preferencias_tabla' }, CAMARERO)).status, 403);
  assert.equal(db.obtener(tables.ajustes, { PK: 'IA', SK: 'CONFIG' }).modelo, 'caro');

  assert.equal((await api('PATCH', '/api/ajustes/IA/CONFIG', { modelo: 'otro' }, ADMIN)).status, 200);
});

// ─── Favoritos: solo los propios ───

test('cada usuario lee y escribe sus favoritos, pero no los de otro', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'favoritos', SK: '000002', valor: [{ route: '/banca' }] });

  const propios = await api('PATCH', '/api/ajustes/favoritos/000009', { valor: [{ route: '/cajas' }] }, CAMARERO);
  assert.equal(propios.status, 200);
  assert.deepEqual(db.obtener(tables.ajustes, { PK: 'favoritos', SK: '000009' }).valor, [{ route: '/cajas' }]);
  assert.equal((await api('GET', '/api/ajustes/favoritos/000009', undefined, CAMARERO)).status, 200);

  const leerAjenos = await api('GET', '/api/ajustes/favoritos/000002', undefined, CAMARERO);
  assert.equal(leerAjenos.status, 403);
  const escribirAjenos = await api('PATCH', '/api/ajustes/favoritos/000002', { valor: [] }, CAMARERO);
  assert.equal(escribirAjenos.status, 403);
  assert.deepEqual(db.obtener(tables.ajustes, { PK: 'favoritos', SK: '000002' }).valor, [{ route: '/banca' }]);

  const categoria = await api('GET', '/api/ajustes?categoria=favoritos', undefined, CAMARERO);
  assert.deepEqual(categoria.body.items.map((i) => i.SK), ['000009']);
});

// ─── Pantallas con su permiso ───

test('con rrhh.horas se leen y escriben los ratios €/hora por local; sin él no', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'RATIO_HORAS_LOCAL', SK: '000010', ratio: 30 });

  const leer = await api('GET', '/api/ajustes?categoria=RATIO_HORAS_LOCAL', undefined, RRHH);
  assert.equal(leer.status, 200);
  assert.deepEqual(leer.body.items.map((i) => i.ratio), [30]);

  const escribir = await api('POST', '/api/ajustes', { PK: 'RATIO_HORAS_LOCAL', SK: '000010', ratio: 35 }, RRHH);
  assert.equal(escribir.status, 200);
  assert.equal(db.obtener(tables.ajustes, { PK: 'RATIO_HORAS_LOCAL', SK: '000010' }).ratio, 35);

  assert.equal((await api('GET', '/api/ajustes?categoria=RATIO_HORAS_LOCAL', undefined, CAMARERO)).status, 403);
  assert.equal((await api('POST', '/api/ajustes', { PK: 'RATIO_HORAS_LOCAL', SK: '000010', ratio: 1 }, CAMARERO)).status, 403);
});

test('cada sincronización se configura con su permiso; el estado lo lee cualquiera con una de ellas', async () => {
  const db = escenario();
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'empleados_factorial', Enabled: false });
  db.sembrar(tables.ajustes, { PK: 'sincronizaciones', SK: 'closeouts', Enabled: false });

  const leer = await api('GET', '/api/ajustes?categoria=sincronizaciones', undefined, ENCARGADO);
  assert.equal(leer.status, 200);
  assert.equal(leer.body.items.length, 2);

  const propia = await api('PATCH', '/api/ajustes/sincronizaciones/empleados_factorial', { Enabled: true }, ENCARGADO);
  assert.equal(propia.status, 200);
  const ajena = await api('PATCH', '/api/ajustes/sincronizaciones/closeouts', { Enabled: true }, ENCARGADO);
  assert.equal(ajena.status, 403);
  assert.equal(db.obtener(tables.ajustes, { PK: 'sincronizaciones', SK: 'closeouts' }).Enabled, false);

  assert.equal((await api('GET', '/api/ajustes?categoria=sincronizaciones', undefined, CAMARERO)).status, 403);
});

// ─── Facturación periódica: igual que antes ───

test('el interruptor de la facturación sigue protegido', async () => {
  const db = escenario();
  const r = await api('PATCH', '/api/ajustes/compras/facturacion', { Enabled: true }, CAMARERO);
  assert.equal(r.status, 403);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }), null);
  assert.equal((await api('PATCH', '/api/ajustes/mantenimiento/facturacion', { Enabled: true }, CAMARERO)).status, 403);
});

test('con compras.facturar / mantenimiento.facturar la configuración se lee y se escribe', async () => {
  const db = escenario();

  const compras = await api('POST', '/api/ajustes', { PK: 'compras', SK: 'facturacion', Enabled: true }, FACTURADOR);
  assert.equal(compras.status, 200);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }).Enabled, true);
  assert.equal((await api('GET', '/api/ajustes/compras/facturacion', undefined, FACTURADOR)).status, 200);

  const mant = await api('PATCH', '/api/ajustes/mantenimiento/facturacion', { serie: 'FMT' }, FACTURADOR);
  assert.equal(mant.status, 200);
  assert.equal((await api('GET', '/api/ajustes/mantenimiento/facturacion', undefined, FACTURADOR)).status, 200);
});

test('un usuario no autenticado no puede tocar ajustes', async () => {
  const db = escenario();
  const r = await api('POST', '/api/ajustes', { PK: 'compras', SK: 'facturacion' }, null);
  assert.equal(r.status, 401);
  assert.equal(db.obtener(tables.ajustes, { PK: 'compras', SK: 'facturacion' }), null);
});
