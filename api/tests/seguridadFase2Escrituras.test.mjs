/**
 * Plan de seguridad 2026-11-01, fase 2: escrituras y fugas que dependían solo
 * del permiso global y no miraban el local o la sociedad del registro.
 *
 * - Sesiones de activaciones (POST, PATCH, DELETE) comprueban el local.
 * - Conciliación bancaria: `descartar` mira la sociedad de la factura e
 *   `ignorar` la de la cuenta del movimiento.
 * - `rappel-preview` comprueba el local del pedido.
 * - `conflicto-artista` avisa del conflicto sin datos de locales ajenos.
 * - `marketing/imagen-url` solo firma claves visibles para el usuario.
 *
 * Un usuario con alcance global (Administrador) no nota nada.
 */

import test, { after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';
import 'express-async-errors';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-la-fase-2';
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'AKIAPRUEBAS';
process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'secreto-de-pruebas';

const { montarEscenario, tables, local, empresa, EMPRESA_NORTE, EMPRESA_SUR } = await import('./escenarioFacturacion.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { invalidarMaestroLocales } = await import('../lib/alcance.js');
const { aplicarClavesGsi, clavesActuacion } = await import('../lib/clavesIndice.js');
const { default: activacionesRouter } = await import('../routes/activaciones.js');
const { default: bancaConciliacionRouter } = await import('../routes/bancaConciliacion.js');
const { default: pedidosRouter } = await import('../routes/pedidos.js');
const { default: actuacionesRouter } = await import('../routes/artistasActuaciones.js');
const { default: marketingRouter } = await import('../routes/marketing.js');

const ROL = 'Encargado';
const PERMISOS = [
  'activaciones.ver',
  'activaciones.gestionar',
  'actuaciones.crear',
  'marketing.proponer',
  'facturacion.cobrar_pagar',
  'banca.importar',
];
const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const NORTE = { sub: 'u-norte', email: 'norte@grupo.test', rol: ROL };
// Marketing guarda en `Local` ids de local (getUserLocales los normaliza con formatId6).
const MK = { sub: '000050', email: 'mk@grupo.test', rol: ROL };

const IBAN_NORTE = 'ES1000492352082414205416';
const IBAN_SUR = 'ES9121000418450200051332';

let db;
let usuarioActual = NORTE;
let servidor = null;
let base = '';

beforeEach(() => {
  delete process.env.ALCANCE_MODO_LECTURAS;
  db = montarEscenario();
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.activaciones, { hashKey: 'id_activacion' });
  db.crearTabla(tables.activacionSesiones, {
    hashKey: 'id_sesion',
    indices: { 'activacion-index': { hashKey: 'id_activacion' } },
  });
  db.crearTabla(tables.bankMovements, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'EmpresaId-FechaOperacion-index': { hashKey: 'empresaId', rangeKey: 'fechaOperacion' },
      'Estado-FechaOperacion-index': { hashKey: 'estadoConciliacion', rangeKey: 'fechaOperacion' },
    },
  });
  db.crearTabla(tables.actuaciones, {
    hashKey: 'id_actuacion',
    indices: {
      'Listado-Fecha-index': { hashKey: 'gsi_listado', rangeKey: 'gsi_fecha' },
      'Artista-Fecha-index': { hashKey: 'gsi_artista', rangeKey: 'gsi_fecha' },
    },
  });
  db.crearTabla(tables.marketing, { hashKey: 'id_propuesta' });

  db.sembrar(tables.locales, {
    ...local('000010', 'Local Norte', EMPRESA_NORTE),
    estilo_visual_imagen_keys: ['marketing/estilo-local/norte.jpg'],
  });
  db.sembrar(tables.locales, {
    ...local('000020', 'Local Sur', EMPRESA_SUR),
    estilo_visual_imagen_keys: ['marketing/estilo-local/sur.jpg'],
  });
  db.sembrar(tables.empresas, empresa(EMPRESA_NORTE, 'Norte'));
  db.sembrar(tables.empresas, empresa(EMPRESA_SUR, 'Sur'));
  db.sembrar(tables.usuarios, { id_usuario: 'u-norte', Email: NORTE.email, Local: ['Local Norte'], Rol: ROL });
  db.sembrar(tables.usuarios, { id_usuario: '000050', Email: MK.email, Local: ['000010'], Rol: ROL });
  db.sembrar(tables.usuarios, { id_usuario: '000001', Email: ADMIN.email, Rol: 'Administrador' });
  for (const p of PERMISOS) db.sembrar(tables.rolesPermisos, { PK: `ROL#${ROL}`, SK: `PERMISO#${p}` });

  db.sembrar(tables.activaciones, { id_activacion: 'A1', codigo: 'A1', marca: 'M', producto: 'P', duracion_horas: 2 });
  db.sembrar(tables.activacionSesiones, {
    id_sesion: 'S-NORTE', id_activacion: 'A1', id_local: '000010', fecha: '2026-11-10',
    hora_inicio: '20:00', hora_fin: '22:00', estado_sesion: 'programada',
  });
  db.sembrar(tables.activacionSesiones, {
    id_sesion: 'S-SUR', id_activacion: 'A1', id_local: '000020', fecha: '2026-11-10',
    hora_inicio: '20:00', hora_fin: '22:00', estado_sesion: 'programada',
  });

  db.sembrar(tables.facturas, { id_factura: 'F-NORTE', emisor_id: EMPRESA_NORTE, tipo: 'OUT' });
  db.sembrar(tables.facturas, { id_factura: 'F-SUR', emisor_id: EMPRESA_SUR, tipo: 'OUT' });
  for (const [iban, empresaId, hash] of [[IBAN_NORTE, EMPRESA_NORTE, 'hn'], [IBAN_SUR, EMPRESA_SUR, 'hs']]) {
    db.sembrar(tables.bankMovements, {
      PK: `ACCOUNT#${iban}`,
      SK: `TXN#2026-02-10#${hash}`,
      cuentaRef: iban,
      movementHash: hash,
      fechaOperacion: '2026-02-10',
      estadoConciliacion: 'pendiente',
      importeCentimos: 1000,
      empresaId,
    });
  }

  db.sembrar(tables.pedidos, { Id: 'PED-SUR', LocalId: '000020', Fecha: '2026-10-01', Estado: 'Enviado' });

  const actuacionSur = {
    id_actuacion: 'ACT-SUR', id_local: '000020', local_nombre_snapshot: 'Local Sur', estado: 'confirmada',
    fecha: '2026-10-12', hora_inicio: '22:00', id_artista: 'art-1', artista_nombre_snapshot: 'Trío',
  };
  aplicarClavesGsi(actuacionSur, clavesActuacion(actuacionSur));
  db.sembrar(tables.actuaciones, actuacionSur);

  db.sembrar(tables.marketing, { id_propuesta: 'P-NORTE', id_local: '000010', estado: 'pendiente', imagen_referencia_url: 'marketing/referencia/norte.jpg' });
  db.sembrar(tables.marketing, { id_propuesta: 'P-SUR', id_local: '000020', imagen_referencia_url: 'marketing/referencia/sur.jpg' });

  invalidarContextoAcceso();
  invalidarMaestroLocales();
});

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

async function api(metodo, ruta, cuerpo, usuario = NORTE) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    for (const r of [activacionesRouter, bancaConciliacionRouter, pedidosRouter, actuacionesRouter, marketingRouter]) {
      app.use('/api', r);
    }
    app.use((err, _req, res, _next) => {
      res.status(err.status || 500).json({ error: err.message });
    });
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

const sesion = (id) => db.obtener(tables.activacionSesiones, { id_sesion: id });

// ─── Activaciones: sesiones ───

test('activaciones: crear sesiones en un local ajeno da 403 y no escribe ninguna', async () => {
  const antes = db.listar(tables.activacionSesiones).length;
  const r = await api('POST', '/api/activaciones/A1/sesiones', [
    { id_local: '000010', fecha: '2026-11-11', hora_inicio: '20:00' },
    { id_local: '000020', fecha: '2026-11-11', hora_inicio: '20:00' },
  ]);
  assert.equal(r.status, 403);
  assert.equal(db.listar(tables.activacionSesiones).length, antes);

  const propia = await api('POST', '/api/activaciones/A1/sesiones', { id_local: '000010', fecha: '2026-11-11', hora_inicio: '20:00' });
  assert.equal(propia.status, 201, JSON.stringify(propia.body));
});

test('activaciones: cambiar horario de una sesión ajena da 403 aunque se tenga gestionar', async () => {
  const r = await api('PATCH', '/api/activaciones/sesiones/S-SUR', { fecha: '2026-11-12' });
  assert.equal(r.status, 403);
  assert.equal(sesion('S-SUR').fecha, '2026-11-10');
});

test('activaciones: mover una sesión propia a un local ajeno da 403', async () => {
  const r = await api('PATCH', '/api/activaciones/sesiones/S-NORTE', { id_local: '000020' });
  assert.equal(r.status, 403);
  assert.equal(sesion('S-NORTE').id_local, '000010');

  const ok = await api('PATCH', '/api/activaciones/sesiones/S-NORTE', { estado_sesion: 'cancelada', fecha: '2026-11-12' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(sesion('S-NORTE').fecha, '2026-11-12');
});

test('activaciones: borrar sesión ajena da 403, inexistente 404 y propia 200', async () => {
  assert.equal((await api('DELETE', '/api/activaciones/sesiones/S-SUR')).status, 403);
  assert.ok(sesion('S-SUR'));
  assert.equal((await api('DELETE', '/api/activaciones/sesiones/NO-EXISTE')).status, 404);
  assert.equal((await api('DELETE', '/api/activaciones/sesiones/S-NORTE')).status, 200);
  assert.equal(sesion('S-NORTE'), null);
});

test('activaciones: el Administrador mueve y borra sesiones de cualquier local', async () => {
  const mover = await api('PATCH', '/api/activaciones/sesiones/S-NORTE', { id_local: '000020' }, ADMIN);
  assert.equal(mover.status, 200, JSON.stringify(mover.body));
  assert.equal(sesion('S-NORTE').id_local, '000020');
  assert.equal((await api('DELETE', '/api/activaciones/sesiones/S-SUR', undefined, ADMIN)).status, 200);
});

// ─── Conciliación bancaria ───

const movimiento = (iban, hash) => ({ cuentaRef: iban, movementHash: hash, fechaOperacion: '2026-02-10' });
const mov = (iban, hash) => db.obtener(tables.bankMovements, { PK: `ACCOUNT#${iban}`, SK: `TXN#2026-02-10#${hash}` });

test('conciliación: descartar una factura de otra sociedad da 404 y no toca el movimiento', async () => {
  const r = await api('POST', '/api/banca/conciliacion/descartar', { ...movimiento(IBAN_NORTE, 'hn'), id_factura: 'F-SUR' });
  assert.equal(r.status, 404);
  assert.equal(mov(IBAN_NORTE, 'hn').sugerenciasDescartadas, undefined);

  const ok = await api('POST', '/api/banca/conciliacion/descartar', { ...movimiento(IBAN_NORTE, 'hn'), id_factura: 'F-NORTE' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(mov(IBAN_NORTE, 'hn').sugerenciasDescartadas, ['F-NORTE']);
});

test('conciliación: descartar sobre un movimiento de otra sociedad da 404 aunque la factura sea suya', async () => {
  const r = await api('POST', '/api/banca/conciliacion/descartar', { ...movimiento(IBAN_SUR, 'hs'), id_factura: 'F-NORTE' });
  assert.equal(r.status, 404);
  assert.equal(mov(IBAN_SUR, 'hs').sugerenciasDescartadas, undefined);
});

test('conciliación: ignorar un movimiento de otra sociedad da 404 y no cambia su estado', async () => {
  const r = await api('POST', '/api/banca/conciliacion/ignorar', movimiento(IBAN_SUR, 'hs'));
  assert.equal(r.status, 404);
  assert.equal(mov(IBAN_SUR, 'hs').estadoConciliacion, 'pendiente');

  const ok = await api('POST', '/api/banca/conciliacion/ignorar', movimiento(IBAN_NORTE, 'hn'));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(mov(IBAN_NORTE, 'hn').estadoConciliacion, 'ignorado');
});

test('conciliación: el Administrador descarta e ignora en cualquier sociedad', async () => {
  const d = await api('POST', '/api/banca/conciliacion/descartar', { ...movimiento(IBAN_SUR, 'hs'), id_factura: 'F-SUR' }, ADMIN);
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const i = await api('POST', '/api/banca/conciliacion/ignorar', movimiento(IBAN_SUR, 'hs'), ADMIN);
  assert.equal(i.status, 200, JSON.stringify(i.body));
});

// ─── Pedidos: rappel-preview ───

test('rappel-preview: con lecturas bloqueadas, un pedido de otro local da 403; inexistente 404', async () => {
  process.env.ALCANCE_MODO_LECTURAS = 'bloquear';
  assert.equal((await api('GET', '/api/pedidos/PED-SUR/rappel-preview?productId=P1&cantidad=2')).status, 403);
  assert.equal((await api('GET', '/api/pedidos/NO-EXISTE/rappel-preview?productId=P1&cantidad=2')).status, 404);
});

// ─── Actuaciones: conflicto-artista ───

const consultaConflicto = { id_artista: 'art-1', fecha: '2026-10-12', hora_inicio: '22:00' };

test('conflicto-artista: avisa del conflicto en un local ajeno sin id, local ni estado', async () => {
  const r = await api('POST', '/api/actuaciones/conflicto-artista', consultaConflicto);
  assert.equal(r.status, 200);
  assert.equal(r.body.conflicto, true);
  assert.deepEqual(r.body.otro, {
    id_actuacion: '',
    fecha: '2026-10-12',
    hora_inicio: '22:00',
    id_local: '',
    local_nombre_snapshot: 'Otro local (sin acceso)',
    estado: '',
    id_artista: 'art-1',
    artista_nombre_snapshot: 'Trío',
  });
});

test('conflicto-artista: el Administrador ve el detalle completo', async () => {
  const r = await api('POST', '/api/actuaciones/conflicto-artista', consultaConflicto, ADMIN);
  assert.equal(r.body.otro.id_actuacion, 'ACT-SUR');
  assert.equal(r.body.otro.id_local, '000020');
  assert.equal(r.body.otro.local_nombre_snapshot, 'Local Sur');
});

// ─── Marketing: imagen-url ───

const imagen = (key, usuario = MK) => api('GET', `/api/marketing/imagen-url?key=${encodeURIComponent(key)}`, undefined, usuario);

test('imagen-url: firma las imágenes de propuestas y estilo de sus locales, no las ajenas', async () => {
  assert.equal((await imagen('marketing/referencia/norte.jpg')).status, 200);
  assert.equal((await imagen('marketing/estilo-local/norte.jpg')).status, 200);
  assert.equal((await imagen('marketing/referencia/sur.jpg')).status, 403);
  assert.equal((await imagen('marketing/estilo-local/sur.jpg')).status, 403);
  assert.equal((await imagen('marketing/final/cualquiera.jpg')).status, 403);
});

test('imagen-url: la imagen recién subida por el propio usuario se firma aunque aún no esté guardada', async () => {
  assert.equal((await imagen('marketing/referencia/abc.u000050.jpg')).status, 200);
  assert.equal((await imagen('marketing/referencia/abc.u000099.jpg')).status, 403);
});

const estiloNorte = () => db.obtener(tables.locales, { id_Locales: '000010' }).estilo_visual_imagen_keys;
const refNorte = () => db.obtener(tables.marketing, { id_propuesta: 'P-NORTE' }).imagen_referencia_url;

test('estilo del local: un no gestor no puede guardar claves copiadas de otro local', async () => {
  const copia = await api('PATCH', '/api/marketing/locales/000010/estilo', {
    estilo_visual_imagen_keys: ['marketing/estilo-local/norte.jpg', 'marketing/estilo-local/sur.jpg'],
  }, MK);
  assert.equal(copia.status, 400);
  assert.deepEqual(estiloNorte(), ['marketing/estilo-local/norte.jpg']);
  assert.equal((await imagen('marketing/estilo-local/sur.jpg')).status, 403);

  const propias = await api('PATCH', '/api/marketing/locales/000010/estilo', {
    estilo_visual_imagen_keys: ['marketing/estilo-local/norte.jpg', 'marketing/estilo-local/nueva.u000050.jpg'],
  }, MK);
  assert.equal(propias.status, 200, JSON.stringify(propias.body));
  assert.deepEqual(estiloNorte(), ['marketing/estilo-local/norte.jpg', 'marketing/estilo-local/nueva.u000050.jpg']);
});

test('estilo del local: el Administrador guarda cualquier clave', async () => {
  const r = await api('PATCH', '/api/marketing/locales/000010/estilo', {
    estilo_visual_imagen_keys: ['marketing/estilo-local/sur.jpg'],
  }, ADMIN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test('propuestas: un no gestor no puede poner como referencia una clave ajena', async () => {
  const base = { tipo: 'Oferta', redes: ['instagram'], fecha_sugerida: '2026-11-20', descripcion: 'Promo', id_local: '000010' };
  const alta = await api('POST', '/api/marketing/propuestas', { ...base, imagen_referencia_url: 'marketing/referencia/sur.jpg' }, MK);
  assert.equal(alta.status, 400);
  const altaOk = await api('POST', '/api/marketing/propuestas', { ...base, imagen_referencia_url: 'marketing/referencia/x.u000050.jpg' }, MK);
  assert.equal(altaOk.status, 201, JSON.stringify(altaOk.body));
  const altaUrl = await api('POST', '/api/marketing/propuestas', { ...base, imagen_referencia_url: 'https://ejemplo.test/foto.jpg' }, MK);
  assert.equal(altaUrl.status, 201, JSON.stringify(altaUrl.body));

  const edicion = await api('PATCH', '/api/marketing/propuestas/P-NORTE', { imagen_referencia_url: 'marketing/referencia/sur.jpg' }, MK);
  assert.equal(edicion.status, 400);
  assert.equal(refNorte(), 'marketing/referencia/norte.jpg');
  const misma = await api('PATCH', '/api/marketing/propuestas/P-NORTE', { imagen_referencia_url: 'marketing/referencia/norte.jpg', descripcion: 'Otra' }, MK);
  assert.equal(misma.status, 200, JSON.stringify(misma.body));
});

test('imagen-url: el Administrador firma cualquier clave de marketing', async () => {
  const r = await imagen('marketing/referencia/sur.jpg', ADMIN);
  assert.equal(r.status, 200);
  assert.ok(r.body.url);
});
