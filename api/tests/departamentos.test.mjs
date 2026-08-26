/**
 * Maestro de departamentos y campo `Departamentos` de la ficha de usuario.
 *
 * Lo que se prueba aquí no es que el CRUD escriba: es que las tres reglas que
 * lo hacen usable no se rompan. El nombre duplicado se detecta comparando sin
 * mayúsculas ni espacios sobrantes (si no, acaban dos «Marketing» en el
 * desplegable y nadie sabe cuál elegir). El borrado es **siempre lógico**,
 * porque hay `departamento_id` grabado en tareas, proyectos y fichas de usuario
 * sin integridad referencial: si la fila desapareciera, lo ya guardado dejaría
 * de resolver su nombre. Y un id de departamento que no existe se descarta en
 * silencio al guardar un usuario, en lugar de tumbar el alta entera.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-departamentos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { signToken } = await import('../lib/jwt.js');
const { default: departamentosRouter } = await import('../routes/departamentos.js');
const { default: usuariosRouter } = await import('../routes/usuarios.js');
const { default: authRouter } = await import('../routes/auth.js');
const { obtenerDepartamento, responsableDeDepartamento } = await import('../lib/tasks/departamentos.js');

/** Administrador: `hasPermission` lo da por bueno sin leer la tabla de permisos. */
const ADMIN = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
/** Sin ningún permiso concedido: el que las escrituras deben frenar. */
const CAMARERO = { sub: '000009', email: 'camarero@grupo.test', rol: 'Camarero' };

let usuarioActual = ADMIN;
let servidor = null;
let base = '';

/** `usuario: null` no inyecta sesión: lo usan las rutas que validan el token. */
async function api(metodo, ruta, cuerpo, usuario = ADMIN, cabeceras = {}) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', departamentosRouter);
    app.use('/api', usuariosRouter);
    app.use('/api', authRouter);
    servidor = http.createServer(app);
    await new Promise((listo) => servidor.listen(0, '127.0.0.1', listo));
    base = `http://127.0.0.1:${servidor.address().port}`;
  }
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...cabeceras },
    ...(cuerpo !== undefined && { body: JSON.stringify(cuerpo) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

after(() => {
  servidor?.closeAllConnections?.();
  servidor?.close();
});

/** `paginaTam` fuerza la paginación: así se ejercita el `do/while` del listado. */
function montar() {
  const db = crearDynamoMemoria({ paginaTam: 2 });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  return db;
}

function sembrarDep(db, { id, nombre, activo = true, orden = 0, responsable_id = '' }) {
  db.sembrar(tables.ajustes, {
    PK: 'departamentos',
    SK: `DEP#${id}`,
    nombre,
    responsable_id,
    activo,
    orden,
  });
  return id;
}

function crudo(db, id) {
  return db.obtener(tables.ajustes, { PK: 'departamentos', SK: `DEP#${id}` });
}

// ─── Alta ───

test('el alta nace activa y con id propio, no derivado del nombre', async () => {
  const db = montar();
  const r = await api('POST', '/api/departamentos', { nombre: 'Marketing', orden: 3 });

  assert.equal(r.status, 200);
  assert.equal(r.body.departamento.nombre, 'Marketing');
  assert.equal(r.body.departamento.activo, true);
  assert.equal(r.body.departamento.orden, 3);
  // El nombre se edita: un slug derivado dejaría desincronizados los
  // `departamento_id` ya guardados en tareas, proyectos y fichas.
  assert.notEqual(r.body.departamento.id, 'marketing');
  assert.ok(r.body.departamento.id.length > 10);
  assert.equal(db.listar(tables.ajustes).length, 1);
});

test('el nombre duplicado se rechaza con 409 sin mirar mayúsculas ni espacios sobrantes', async () => {
  const db = montar();
  const primero = await api('POST', '/api/departamentos', { nombre: 'Recursos Humanos' });
  assert.equal(primero.status, 200);

  for (const variante of ['Recursos Humanos', 'recursos humanos', '  RECURSOS   humanos  ']) {
    const r = await api('POST', '/api/departamentos', { nombre: variante });
    assert.equal(r.status, 409, variante);
    assert.match(r.body.error, /Ya existe un departamento/);
  }
  assert.equal(db.listar(tables.ajustes).length, 1, 'ninguna variante debe haber creado fila');
});

test('el nombre se guarda sin espacios sobrantes', async () => {
  montar();
  const r = await api('POST', '/api/departamentos', { nombre: '  Sala   y  Barra ' });
  assert.equal(r.body.departamento.nombre, 'Sala y Barra');
});

test('sin nombre no hay departamento', async () => {
  const db = montar();
  for (const nombre of [undefined, '', '   ', null]) {
    const r = await api('POST', '/api/departamentos', { nombre });
    assert.equal(r.status, 400, String(nombre));
  }
  assert.equal(db.listar(tables.ajustes).length, 0);
});

// ─── Listado ───

test('la lista va por orden y, a igualdad, por nombre', async () => {
  const db = montar();
  sembrarDep(db, { id: 'a', nombre: 'Ventas', orden: 2 });
  sembrarDep(db, { id: 'b', nombre: 'Compras', orden: 1 });
  sembrarDep(db, { id: 'c', nombre: 'Almacén', orden: 1 });
  sembrarDep(db, { id: 'd', nombre: 'Obsoleto', orden: 0, activo: false });

  const r = await api('GET', '/api/departamentos');
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.departamentos.map((d) => d.nombre),
    ['Obsoleto', 'Almacén', 'Compras', 'Ventas'],
  );
});

test('soloActivos deja fuera las bajas, que es lo que piden los desplegables', async () => {
  const db = montar();
  sembrarDep(db, { id: 'a', nombre: 'Marketing' });
  sembrarDep(db, { id: 'b', nombre: 'Obsoleto', activo: false });

  const todos = await api('GET', '/api/departamentos');
  assert.equal(todos.body.departamentos.length, 2, 'el mantenimiento del maestro sí ve las bajas');

  for (const query of ['?soloActivos=1', '?soloActivos=true']) {
    const r = await api('GET', `/api/departamentos${query}`);
    assert.deepEqual(r.body.departamentos.map((d) => d.nombre), ['Marketing'], query);
  }
});

test('una fila sin `activo` cuenta como activa', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, { PK: 'departamentos', SK: 'DEP#viejo', nombre: 'Escrito a mano' });
  const r = await api('GET', '/api/departamentos?soloActivos=1');
  assert.deepEqual(r.body.departamentos.map((d) => d.nombre), ['Escrito a mano']);
});

test('el listado no se lleva por delante otros ajustes de la misma tabla', async () => {
  const db = montar();
  sembrarDep(db, { id: 'a', nombre: 'Marketing' });
  db.sembrar(tables.ajustes, { PK: 'proyectos', SK: 'compras', umbral_responsable: 300 });
  db.sembrar(tables.ajustes, { PK: 'departamentos', SK: 'otra_cosa', valor: 1 });

  const r = await api('GET', '/api/departamentos');
  assert.deepEqual(r.body.departamentos.map((d) => d.nombre), ['Marketing']);
});

// ─── Nombre del responsable ───

test('el listado resuelve el nombre del responsable con una sola lectura', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, {
    id_usuario: '000007',
    Nombre: 'Ana',
    Apellidos: 'Ruiz',
    Email: 'ana@igp.local',
    Password: 'hash',
  });
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', responsable_id: '000007' });
  sembrarDep(db, { id: 'rrhh', nombre: 'Recursos Humanos', orden: 1, responsable_id: '000007' });
  sembrarDep(db, { id: 'sala', nombre: 'Sala', orden: 2 });

  // La pantalla del maestro se abre con `base_datos.ver`: quien no tenga
  // `usuarios.ver` tiene que ver el nombre igual, no el id crudo.
  const r = await api('GET', '/api/departamentos', undefined, CAMARERO);
  assert.equal(r.status, 200);
  const porId = Object.fromEntries(r.body.departamentos.map((d) => [d.id, d]));
  assert.equal(porId.mkt.responsable_nombre, 'Ana Ruiz');
  assert.equal(porId.rrhh.responsable_nombre, 'Ana Ruiz');
  assert.equal(porId.sala.responsable_nombre, null, 'sin responsable no hay nombre');

  const lotes = db.operaciones.filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(lotes.length, 1, 'una sola operación para toda la lista');
  assert.equal(lotes[0].claves, 1, 'el responsable repetido no se lee dos veces');
  assert.equal(
    db.operaciones.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.usuarios).length,
    0,
    'nada de una lectura por fila',
  );
});

test('un responsable borrado devuelve nombre nulo sin tumbar el listado', async () => {
  const db = montar();
  // No hay integridad referencial contra igp_usuarios: el id puede apuntar a
  // alguien que ya no está.
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', responsable_id: '000404' });

  const r = await api('GET', '/api/departamentos');
  assert.equal(r.status, 200);
  assert.equal(r.body.departamentos[0].responsable_nombre, null);
});

test('el alta y la edición devuelven el nombre resuelto, sin recargar la lista', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, { id_usuario: '000007', Nombre: 'Ana', Apellidos: 'Ruiz' });
  db.sembrar(tables.usuarios, { id_usuario: '000008', Email: 'bea@igp.local' });

  const alta = await api('POST', '/api/departamentos', { nombre: 'Marketing', responsable_id: '000007' });
  assert.equal(alta.body.departamento.responsable_nombre, 'Ana Ruiz');

  // Sin nombre ni apellidos queda el email, el mismo criterio del resto del ERP.
  const ruta = `/api/departamentos/${alta.body.departamento.id}`;
  const cambio = await api('PATCH', ruta, { responsable_id: '000008' });
  assert.equal(cambio.body.departamento.responsable_nombre, 'bea@igp.local');

  const sinNadie = await api('PATCH', ruta, { responsable_id: '' });
  assert.equal(sinNadie.body.departamento.responsable_nombre, null);
});

// ─── Edición ───

test('editar cambia solo lo que llega', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', orden: 5, responsable_id: '000007' });

  const r = await api('PATCH', '/api/departamentos/mkt', { nombre: 'Marketing y RRSS' });
  assert.equal(r.status, 200);
  assert.equal(r.body.departamento.nombre, 'Marketing y RRSS');
  assert.equal(r.body.departamento.responsable_id, '000007');
  assert.equal(r.body.departamento.orden, 5);
  assert.equal(r.body.departamento.activo, true);
  assert.equal(crudo(db, 'mkt').nombre, 'Marketing y RRSS');
});

test('editar mantiene la comprobación de nombre duplicado, pero no consigo mismo', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });
  sembrarDep(db, { id: 'rrhh', nombre: 'Recursos Humanos' });

  const choque = await api('PATCH', '/api/departamentos/rrhh', { nombre: '  marketing ' });
  assert.equal(choque.status, 409);
  assert.equal(crudo(db, 'rrhh').nombre, 'Recursos Humanos');

  // Renombrarse a sí mismo cambiando solo mayúsculas tiene que poder hacerse.
  const propio = await api('PATCH', '/api/departamentos/mkt', { nombre: 'MARKETING' });
  assert.equal(propio.status, 200);
  assert.equal(crudo(db, 'mkt').nombre, 'MARKETING');
});

test('reactivar una baja es la vía para reutilizar su nombre', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', activo: false });

  // Crear otro con el mismo nombre dejaría dos «Marketing» en los desplegables.
  const duplicado = await api('POST', '/api/departamentos', { nombre: 'Marketing' });
  assert.equal(duplicado.status, 409);

  const alta = await api('PATCH', '/api/departamentos/mkt', { activo: true });
  assert.equal(alta.status, 200);
  assert.equal(alta.body.departamento.activo, true);
});

test('un activo que no dice «sí» no reactiva una baja', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', activo: false });

  // Todo esto llega por HTTP desde un formulario. La cadena vacía es el campo sin
  // rellenar, y darla por buena reactivaba un departamento dado de baja.
  for (const valor of ['', '   ', 'false', '0', 0, null]) {
    const r = await api('PATCH', '/api/departamentos/mkt', { activo: valor });
    assert.equal(r.status, 200, JSON.stringify(valor));
    assert.equal(r.body.departamento.activo, false, JSON.stringify(valor));
    assert.equal(crudo(db, 'mkt').activo, false, JSON.stringify(valor));
  }

  // Reactivar de verdad sigue funcionando, con booleano o con texto.
  assert.equal((await api('PATCH', '/api/departamentos/mkt', { activo: 'true' })).body.departamento.activo, true);
  assert.equal((await api('PATCH', '/api/departamentos/mkt', { activo: false })).body.departamento.activo, false);
  assert.equal((await api('PATCH', '/api/departamentos/mkt', { activo: true })).body.departamento.activo, true);
});

test('editar o dar de baja algo que no existe responde 404', async () => {
  montar();
  assert.equal((await api('PATCH', '/api/departamentos/fantasma', { nombre: 'X' })).status, 404);
  assert.equal((await api('DELETE', '/api/departamentos/fantasma')).status, 404);
});

test('un PATCH sin campos conocidos no vale como edición', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });
  const r = await api('PATCH', '/api/departamentos/mkt', { inventado: true });
  assert.equal(r.status, 400);
});

// ─── Baja lógica ───

test('el borrado deja el ítem con activo:false y el nombre sigue resolviendo', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', responsable_id: '000007' });

  const r = await api('DELETE', '/api/departamentos/mkt');
  assert.equal(r.status, 200);
  assert.equal(r.body.departamento.activo, false);

  const fila = crudo(db, 'mkt');
  assert.ok(fila, 'la fila no se borra nunca: hay departamento_id apuntando a ella');
  assert.equal(fila.activo, false);
  assert.equal(fila.nombre, 'Marketing');

  // Lo ya grabado en tareas, proyectos y fichas sigue pudiendo mostrar su nombre.
  const dep = await obtenerDepartamento('mkt');
  assert.equal(dep.nombre, 'Marketing');
  assert.equal(dep.activo, false);
  assert.equal(await responsableDeDepartamento('mkt'), '000007');

  // Pero deja de ofrecerse en los formularios.
  const activos = await api('GET', '/api/departamentos?soloActivos=1');
  assert.deepEqual(activos.body.departamentos, []);
});

test('responsableDeDepartamento devuelve cadena vacía si no hay responsable o no existe', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });
  assert.equal(await responsableDeDepartamento('mkt'), '');
  assert.equal(await responsableDeDepartamento('fantasma'), '');
  assert.equal(await responsableDeDepartamento(''), '');
});

// ─── Permisos ───

test('la lectura solo pide sesión; las escrituras piden departamentos.editar', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });

  const lectura = await api('GET', '/api/departamentos', undefined, CAMARERO);
  assert.equal(lectura.status, 200, 'sin lectura abierta, los desplegables salen vacíos');

  assert.equal((await api('POST', '/api/departamentos', { nombre: 'Nuevo' }, CAMARERO)).status, 403);
  assert.equal((await api('PATCH', '/api/departamentos/mkt', { nombre: 'Otro' }, CAMARERO)).status, 403);
  assert.equal((await api('DELETE', '/api/departamentos/mkt', undefined, CAMARERO)).status, 403);

  assert.equal(db.listar(tables.ajustes).length, 1);
  assert.equal(crudo(db, 'mkt').activo, true);
});

// ─── Campo Departamentos de la ficha de usuario ───

const USUARIO_NUEVO = { id_usuario: '12', Email: 'Ana@IGP.local', Password: 'secreta123', Rol: '' };

test('los ids de departamento que no existen se descartan sin tumbar el alta', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });

  const r = await api('POST', '/api/usuarios', {
    ...USUARIO_NUEVO,
    Departamentos: ['mkt', 'fantasma', '  mkt  ', ''],
  });

  assert.equal(r.status, 200, 'un id de un departamento borrado no puede impedir dar de alta');
  assert.deepEqual(db.obtener(tables.usuarios, { id_usuario: '000012' }).Departamentos, ['mkt']);
});

test('sin departamentos válidos el atributo no se escribe', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });

  await api('POST', '/api/usuarios', { ...USUARIO_NUEVO, Departamentos: ['fantasma'] });
  const soloFantasmas = db.obtener(tables.usuarios, { id_usuario: '000012' });
  assert.equal(soloFantasmas.Departamentos, undefined, 'es un atributo disperso, no una lista vacía');

  await api('POST', '/api/usuarios', { ...USUARIO_NUEVO, id_usuario: '13' });
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000013' }).Departamentos, undefined);
});

test('un departamento dado de baja sigue siendo una referencia válida en la ficha', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing', activo: false });

  await api('POST', '/api/usuarios', { ...USUARIO_NUEVO, Departamentos: ['mkt'] });
  assert.deepEqual(db.obtener(tables.usuarios, { id_usuario: '000012' }).Departamentos, ['mkt']);
});

test('editar un usuario sin tocar Departamentos no se los borra', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });
  db.sembrar(tables.usuarios, {
    id_usuario: '000012',
    Email: 'ana@igp.local',
    Password: 'hash',
    Nombre: 'Ana',
    Departamentos: ['mkt'],
  });

  // El PUT reconstruye el ítem entero: es justo donde se perdería el campo.
  const r = await api('PUT', '/api/usuarios', { id_usuario: '000012', Email: 'ana@igp.local', Telefono: '600' });
  assert.equal(r.status, 200);
  const guardado = db.obtener(tables.usuarios, { id_usuario: '000012' });
  assert.deepEqual(guardado.Departamentos, ['mkt']);
  assert.equal(guardado.Password, 'hash', 'la password no se toca si no se envía');
});

test('enviar la lista vacía sí quita el atributo', async () => {
  const db = montar();
  sembrarDep(db, { id: 'mkt', nombre: 'Marketing' });
  db.sembrar(tables.usuarios, { id_usuario: '000012', Email: 'ana@igp.local', Departamentos: ['mkt'] });

  await api('PUT', '/api/usuarios', { id_usuario: '000012', Email: 'ana@igp.local', Departamentos: [] });
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000012' }).Departamentos, undefined);
});

test('el listado de usuarios devuelve los departamentos para poder editarlos', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, { id_usuario: '000012', Email: 'ana@igp.local', Departamentos: ['mkt'] });
  db.sembrar(tables.usuarios, { id_usuario: '000013', Email: 'bea@igp.local' });

  const r = await api('GET', '/api/usuarios');
  assert.equal(r.status, 200);
  const ana = r.body.usuarios.find((u) => u.id_usuario === '000012');
  const bea = r.body.usuarios.find((u) => u.id_usuario === '000013');
  assert.deepEqual(ana.Departamentos, ['mkt']);
  assert.equal(bea.Departamentos, undefined);
  assert.equal(ana.Password, undefined, 'la password nunca sale del backend');
});

test('/api/me devuelve Departamentos junto al resto de la sesión', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, {
    id_usuario: '000012',
    Email: 'ana@igp.local',
    Nombre: 'Ana',
    Rol: '',
    Local: ['Bar Central'],
    Departamentos: ['mkt', 'rrhh'],
  });

  const token = signToken({ sub: '000012', email: 'ana@igp.local', rol: '' });
  const r = await api('GET', '/api/me', undefined, null, { Authorization: `Bearer ${token}` });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user.Departamentos, ['mkt', 'rrhh']);
  assert.deepEqual(r.body.user.Locales, ['Bar Central']);
});

test('/api/me devuelve lista vacía cuando la ficha no tiene el atributo', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, { id_usuario: '000013', Email: 'bea@igp.local', Rol: '' });

  const token = signToken({ sub: '000013', email: 'bea@igp.local', rol: '' });
  const r = await api('GET', '/api/me', undefined, null, { Authorization: `Bearer ${token}` });

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user.Departamentos, []);
});

test('el login devuelve Departamentos, igual que /api/me', async () => {
  const db = montar();
  db.sembrar(tables.usuarios, {
    id_usuario: '000012',
    Email: 'ana@igp.local',
    Password: 'secreta123',
    Nombre: 'Ana',
    Rol: '',
    Departamentos: ['mkt', 'rrhh'],
  });
  db.sembrar(tables.usuarios, { id_usuario: '000013', Email: 'bea@igp.local', Password: 'secreta123', Rol: '' });

  // Lo que se guarda en el almacenamiento local es este payload, y es el que se
  // restaura cuando falla la red: sin el campo, la sesión degradada se queda sin
  // departamentos.
  const ana = await api('POST', '/api/login', { email: 'ana@igp.local', password: 'secreta123' }, null);
  assert.equal(ana.status, 200);
  assert.deepEqual(ana.body.user.Departamentos, ['mkt', 'rrhh']);

  const bea = await api('POST', '/api/login', { email: 'bea@igp.local', password: 'secreta123' }, null);
  assert.deepEqual(bea.body.user.Departamentos, []);
});

// ─── Alta de usuario: el id lo propone el cliente ───

test('crear dos veces el mismo id_usuario responde 409 y no machaca al primero', async () => {
  const db = montar();
  const ana = await api('POST', '/api/usuarios', {
    id_usuario: '41',
    Email: 'ana@igp.local',
    Password: 'secreta123',
    Nombre: 'Ana',
    Rol: '',
  });
  assert.equal(ana.status, 200);
  const fichaDeAna = db.obtener(tables.usuarios, { id_usuario: '000041' });

  // Dos administradores con la misma lista cargada proponen el mismo id: sin la
  // condición atómica, este alta machacaría la ficha entera de Ana —email,
  // password y rol incluidos— y la dejaría sin poder entrar.
  const bea = await api('POST', '/api/usuarios', {
    id_usuario: '41',
    Email: 'bea@igp.local',
    Password: 'otra12345',
    Nombre: 'Bea',
    Rol: '',
  });
  assert.equal(bea.status, 409);
  assert.match(bea.body.error, /Recarga la lista/);

  assert.deepEqual(db.obtener(tables.usuarios, { id_usuario: '000041' }), fichaDeAna);
  assert.equal(db.listar(tables.usuarios).length, 1, 'no se ha creado ninguna ficha nueva');
});

test('el alta de un id libre sigue funcionando y la edición no exige que falte', async () => {
  const db = montar();
  const alta = await api('POST', '/api/usuarios', {
    id_usuario: '41',
    Email: 'ana@igp.local',
    Password: 'secreta123',
    Rol: '',
  });
  assert.equal(alta.status, 200);

  // El PUT no puede llevar la condición del POST: ahí el ítem sí debe existir.
  const edicion = await api('PUT', '/api/usuarios', {
    id_usuario: '000041',
    Email: 'ana@igp.local',
    Telefono: '600',
  });
  assert.equal(edicion.status, 200);
  assert.equal(db.obtener(tables.usuarios, { id_usuario: '000041' }).Telefono, '600');
});
