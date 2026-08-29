/**
 * Tareas del módulo de dirección (Fase 1A).
 *
 * Lo que se fija aquí no es que el CRUD escriba, es que no se rompan las reglas
 * que hacen que la lista sirva para algo:
 *
 * - **Cerrar una tarea la saca de la vista personal.** El índice
 *   `Responsable-Vencimiento-index` es disperso y solo contiene tareas abiertas
 *   porque el escritor **borra** `vencimiento_orden` al cerrarlas. Si en su lugar
 *   se escribiera cadena vacía, la vista personal empezaría a mostrar tareas
 *   hechas y nadie sabría por qué.
 * - **Una tarea sin fecha límite ordena al final**, no al principio: si no, lo
 *   primero que se ve al abrir la pantalla es lo que no tiene plazo.
 * - **El acceso se decide con el proyecto delante.** Quien no participa no ve las
 *   tareas ni listando ni pidiéndolas por id, y estar mencionado da lectura pero
 *   nunca escritura.
 * - **Marcar la lista de comprobación no cierra la tarea.** Cerrarla es una
 *   decisión de una persona.
 * - **La creación en lote valida todas antes de escribir ninguna** y no duplica
 *   una propuesta ya convertida, que es lo que evita que una doble pulsación de
 *   «validar» genere dos tareas.
 * - **Filtrar un listado no lee una partición por tarea.**
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-tareas';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK, vencimientoOrdenDe, skProyectoDe, MAX_CHECKLIST } = await import('../lib/tasks/tipos.js');
const { fechaHoyMadrid } = await import('../lib/tasks/tareas.js');
const { configurarAlmacenAdjuntos } = await import('../lib/tasks/adjuntos.js');
const { configurarTransporteEnlaces } = await import('../lib/tasks/enlaces.js');
const { default: tareasRouter } = await import('../routes/tareas.js');

// ─── Personas ───

const ANA = { sub: '000001', email: 'ana@grupo.test', rol: 'Direccion' };
/** Miembro de un proyecto y con `proyectos.ver`: el caso normal. */
const BEA = { sub: '000002', email: 'bea@grupo.test', rol: 'Encargado' };
/** Sin ningún permiso del módulo. */
const CARLOS = { sub: '000003', email: 'carlos@grupo.test', rol: 'Camarero' };
/** Con `tareas.ver_todas`: alcanza proyectos en los que no participa. */
const DORA = { sub: '000004', email: 'dora@grupo.test', rol: 'Auditora' };
/** Con los permisos del módulo pero sin participar en ningún proyecto. */
const EVA = { sub: '000005', email: 'eva@grupo.test', rol: 'Coordinadora' };

const PERMISOS_POR_ROL = {
  Direccion: ['proyectos.ver', 'proyectos.editar', 'proyectos.borrar'],
  Encargado: ['proyectos.ver'],
  Auditora: ['proyectos.ver', 'tareas.ver_todas'],
  Coordinadora: ['proyectos.ver', 'proyectos.editar'],
  Camarero: [],
};

const NOMBRES = {
  '000001': 'Ana Ruiz',
  '000002': 'Bea Soler',
  '000003': 'Carlos Gil',
  '000004': 'Dora Vega',
  '000005': 'Eva Mora',
};

/** Proyecto con Ana como responsable y Bea como miembro. */
const OBRA = 'p-obra';
/** Proyecto en el que Bea no participa. */
const SECRETO = 'p-secreto';

// ─── Servidor con sesión inyectada ───

let usuarioActual = ANA;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ANA) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (usuarioActual) req.user = usuarioActual;
      next();
    });
    app.use('/api', tareasRouter);
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

// ─── Mundo de pruebas ───

function montar({ paginaTam = 0 } = {}) {
  const db = crearDynamoMemoria({ paginaTam });
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
      'Padre-index': { hashKey: 'tarea_padre_id', rangeKey: 'creado_en' },
      'Reunion-index': { hashKey: 'reunion_origen_id', rangeKey: 'creado_en' },
    },
  });
  db.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Miembro-index': { hashKey: 'usuario_id', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' } },
  });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.notificaciones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'NoLeidas-index': {
        hashKey: 'usuario_no_leida',
        rangeKey: 'creado_en',
        proyeccion: 'KEYS_ONLY',
      },
    },
  });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);

  // El contexto de acceso se cachea un minuto por usuario: sin invalidar, una
  // prueba heredaría los permisos de la anterior.
  invalidarContextoAcceso();

  for (const persona of [ANA, BEA, CARLOS, DORA, EVA]) {
    db.sembrar(tables.usuarios, {
      id_usuario: persona.sub,
      Email: persona.email,
      Nombre: NOMBRES[persona.sub],
      Rol: persona.rol,
    });
  }
  for (const [rol, codigos] of Object.entries(PERMISOS_POR_ROL)) {
    for (const codigo of codigos) {
      db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${codigo}` });
    }
  }

  sembrarProyecto(db, {
    id: OBRA,
    nombre: 'Reforma de la barra',
    departamento_id: 'dep-obras',
    responsable_id: ANA.sub,
    miembros: [{ usuario_id: BEA.sub, rol_proyecto: 'miembro' }],
  });
  sembrarProyecto(db, {
    id: SECRETO,
    nombre: 'Nuevo local',
    responsable_id: ANA.sub,
    miembros: [{ usuario_id: EVA.sub, rol_proyecto: 'observador' }],
  });

  return db;
}

function sembrarProyecto(db, { id, nombre, departamento_id = '', responsable_id, miembros = [] }) {
  db.sembrar(tables.proyectos, {
    PK: `PROY#${id}`,
    SK: 'META',
    id_proyecto: id,
    nombre,
    estado: 'activo',
    responsable_id,
    ...(departamento_id && { departamento_id }),
    gsi_listado: 'PROY',
    actualizado_en: '2026-08-01T10:00:00.000Z',
  });
  for (const m of miembros) {
    db.sembrar(tables.proyectos, {
      PK: `PROY#${id}`,
      SK: `MIEMBRO#${m.usuario_id}`,
      usuario_id: m.usuario_id,
      rol_proyecto: m.rol_proyecto,
    });
  }
}

/** Tarea sembrada directamente, con sus claves derivadas como las escribiría el módulo. */
function sembrarTarea(db, datos) {
  const tarea = {
    estado: 'pendiente',
    prioridad: 'media',
    creado_por: ANA.sub,
    creado_en: '2026-08-01T10:00:00.000Z',
    actualizado_en: '2026-08-01T10:00:00.000Z',
    ...datos,
  };
  const item = { PK: PK.tarea(tarea.id_tarea), SK: SK.meta, ...tarea };
  const vencimiento = vencimientoOrdenDe(tarea);
  if (vencimiento) item.vencimiento_orden = vencimiento;
  const skProyecto = skProyectoDe(tarea);
  if (skProyecto) item.sk_proyecto = skProyecto;
  db.sembrar(tables.tareas, item);
  return tarea.id_tarea;
}

function meta(db, idTarea) {
  return db.obtener(tables.tareas, { PK: PK.tarea(idTarea), SK: SK.meta });
}

/** Día natural desplazado respecto a hoy en Madrid, que es con lo que se decide el vencimiento. */
function dia(desplazamiento) {
  const [y, m, d] = fechaHoyMadrid().split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + desplazamiento);
  return fecha.toISOString().slice(0, 10);
}

async function crear(cuerpo, usuario = ANA) {
  const r = await api('POST', '/api/tareas', { responsable_id: ANA.sub, ...cuerpo }, usuario);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.tarea;
}

async function accionesDe(idTarea) {
  const r = await api('GET', `/api/tareas/${idTarea}/actividad`);
  return r.body.actividad.map((a) => a.accion);
}

// ─── Vista personal ───

test('cerrar una tarea la saca de la vista personal y reabrirla la devuelve', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Pedir taburetes', proyecto_id: OBRA, fecha_limite: dia(3) });

  const inicial = await api('GET', '/api/tareas/mias');
  assert.equal(inicial.status, 200);
  assert.deepEqual(inicial.body.tareas.map((t) => t.id_tarea), [tarea.id_tarea]);

  const cierre = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'hecha' });
  assert.equal(cierre.status, 200);
  // El atributo de orden se **borra**: escribir cadena vacía dejaría la tarea
  // dentro del índice y la vista personal seguiría mostrándola.
  assert.equal(meta(db, tarea.id_tarea).vencimiento_orden, undefined);
  assert.match(meta(db, tarea.id_tarea).sk_proyecto, /^cerrada#/);
  assert.ok(meta(db, tarea.id_tarea).cerrada_en);

  const cerrada = await api('GET', '/api/tareas/mias');
  assert.deepEqual(cerrada.body.tareas, []);

  const reapertura = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'pendiente' });
  assert.equal(reapertura.status, 200);
  assert.equal(meta(db, tarea.id_tarea).vencimiento_orden, `${dia(3)}#${tarea.id_tarea}`);
  assert.match(meta(db, tarea.id_tarea).sk_proyecto, /^abierta#/);
  assert.equal(meta(db, tarea.id_tarea).cerrada_en, undefined, 'una tarea reabierta no tiene fecha de cierre');

  const devuelta = await api('GET', '/api/tareas/mias');
  assert.deepEqual(devuelta.body.tareas.map((t) => t.id_tarea), [tarea.id_tarea]);
});

test('una tarea sin fecha límite ordena al final, no al principio', async () => {
  montar();
  const conPlazo = await crear({ titulo: 'Firmar presupuesto', fecha_limite: dia(2) });
  const sinPlazo = await crear({ titulo: 'Repasar proveedores' });
  const lejana = await crear({ titulo: 'Revisar garantías', fecha_limite: dia(40) });

  const r = await api('GET', '/api/tareas/mias');
  assert.deepEqual(
    r.body.tareas.map((t) => t.id_tarea),
    [conPlazo.id_tarea, lejana.id_tarea, sinPlazo.id_tarea],
  );
});

test('el recuento de vencidas cuenta las pasadas de plazo y no las cerradas', async () => {
  const db = montar();
  sembrarTarea(db, { id_tarea: 'v1', titulo: 'Vencida', responsable_id: ANA.sub, fecha_limite: dia(-3) });
  sembrarTarea(db, { id_tarea: 'v2', titulo: 'Vencida ayer', responsable_id: ANA.sub, fecha_limite: dia(-1) });
  sembrarTarea(db, { id_tarea: 'hoy', titulo: 'Vence hoy', responsable_id: ANA.sub, fecha_limite: dia(0) });
  sembrarTarea(db, { id_tarea: 'futura', titulo: 'Vence luego', responsable_id: ANA.sub, fecha_limite: dia(5) });
  sembrarTarea(db, { id_tarea: 'sinplazo', titulo: 'Sin plazo', responsable_id: ANA.sub });
  // Cerrada y pasada de plazo: no está en el índice, así que no cuenta.
  sembrarTarea(db, {
    id_tarea: 'cerrada',
    titulo: 'Vencida pero hecha',
    responsable_id: ANA.sub,
    fecha_limite: dia(-9),
    estado: 'hecha',
  });
  // De otra persona: tampoco.
  sembrarTarea(db, { id_tarea: 'ajena', titulo: 'De Bea', responsable_id: BEA.sub, fecha_limite: dia(-2) });

  const r = await api('GET', '/api/tareas/mias');
  assert.equal(r.body.vencidas, 2, 'lo que vence hoy todavía no está vencido');
  assert.equal(r.body.tareas.length, 5);
});

test('la vista personal pagina sin perder el recuento de vencidas', async () => {
  const db = montar({ paginaTam: 2 });
  for (let i = 0; i < 5; i += 1) {
    sembrarTarea(db, {
      id_tarea: `t${i}`,
      titulo: `Tarea ${i}`,
      responsable_id: ANA.sub,
      fecha_limite: dia(i - 2),
    });
  }

  const primera = await api('GET', '/api/tareas/mias');
  assert.equal(primera.body.tareas.length, 2);
  assert.equal(primera.body.vencidas, 2, 'el recuento es del total, no de la página');
  assert.ok(primera.body.cursor);

  const segunda = await api('GET', `/api/tareas/mias?cursor=${encodeURIComponent(primera.body.cursor)}`);
  assert.equal(segunda.body.tareas.length, 2);
  const vistas = new Set([...primera.body.tareas, ...segunda.body.tareas].map((t) => t.id_tarea));
  assert.equal(vistas.size, 4, 'las páginas no se solapan');
});

// ─── Visibilidad ───

test('quien no participa en un proyecto no ve sus tareas, ni listando ni por id directo', async () => {
  montar();
  const propia = await crear({ titulo: 'Elegir mobiliario', proyecto_id: OBRA });
  const ajena = await crear({ titulo: 'Negociar alquiler', proyecto_id: SECRETO });

  const suyas = await api('GET', `/api/tareas?proyecto=${OBRA}`, undefined, BEA);
  assert.equal(suyas.status, 200);
  assert.deepEqual(suyas.body.tareas.map((t) => t.id_tarea), [propia.id_tarea]);

  const otras = await api('GET', `/api/tareas?proyecto=${SECRETO}`, undefined, BEA);
  assert.equal(otras.status, 200);
  assert.deepEqual(otras.body.tareas, [], 'el filtrado de visibilidad se aplica en el servidor');

  // Por id directo, 404 y no 403: un 403 ya confirmaría que la tarea existe.
  const directa = await api('GET', `/api/tareas/${ajena.id_tarea}`, undefined, BEA);
  assert.equal(directa.status, 404);
  assert.equal((await api('GET', `/api/tareas/${propia.id_tarea}`, undefined, BEA)).status, 200);

  // Quien tiene `tareas.ver_todas` sí alcanza las dos.
  const auditora = await api('GET', `/api/tareas?proyecto=${SECRETO}`, undefined, DORA);
  assert.deepEqual(auditora.body.tareas.map((t) => t.id_tarea), [ajena.id_tarea]);
  assert.equal((await api('GET', `/api/tareas/${ajena.id_tarea}`, undefined, DORA)).status, 200);
});

test('sin permiso del módulo no se entra ni al listado ni a la vista personal', async () => {
  montar();
  assert.equal((await api('GET', '/api/tareas/mias', undefined, CARLOS)).status, 403);
  assert.equal((await api('GET', `/api/tareas?proyecto=${OBRA}`, undefined, CARLOS)).status, 403);
  assert.equal(
    (await api('POST', '/api/tareas', { titulo: 'X', responsable_id: CARLOS.sub }, CARLOS)).status,
    403,
  );
});

test('estar mencionado deja ver la tarea pero no editarla', async () => {
  montar();
  const tarea = await crear({
    titulo: 'Revisar contrato',
    proyecto_id: SECRETO,
    descripcion: 'Lo mira @000002 antes del viernes',
  });
  assert.deepEqual(tarea.menciones, [BEA.sub]);

  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA)).status, 200);

  const edicion = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { titulo: 'Otro título' }, BEA);
  assert.equal(edicion.status, 403, 'la mención da lectura, nunca escritura');

  const estado = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'hecha' }, BEA);
  assert.equal(estado.status, 403);
});

test('un miembro del proyecto con proyectos.editar sí edita la tarea', async () => {
  montar();
  const tarea = await crear({ titulo: 'Pintar la sala', proyecto_id: OBRA });
  // Bea es miembro, pero solo tiene `proyectos.ver`.
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { titulo: 'Pintar' }, BEA)).status, 403);
  // Ana es la responsable del proyecto.
  const propia = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { titulo: 'Pintar la sala grande' });
  assert.equal(propia.status, 200);
  assert.equal(propia.body.tarea.titulo, 'Pintar la sala grande');
});

// ─── Estados ───

test('una transición prohibida responde 422, no 400', async () => {
  montar();
  const tarea = await crear({ titulo: 'Cambiar la instalación' });

  const bloqueo = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, {
    estado: 'bloqueada',
    bloqueo_motivo: 'Falta el informe del electricista',
  });
  assert.equal(bloqueo.status, 200);
  assert.equal(bloqueo.body.tarea.bloqueo_motivo, 'Falta el informe del electricista');

  // Una tarea bloqueada no se da por hecha sin desbloquearla antes: la petición
  // está bien formada, es el estado el que no lo admite.
  const prohibida = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'hecha' });
  assert.equal(prohibida.status, 422);
  assert.match(prohibida.body.error, /no puede pasar/);

  const inventado = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'terminada' });
  assert.equal(inventado.status, 400, 'un estado que no existe sí es petición inválida');

  const desbloqueo = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'en_curso' });
  assert.equal(desbloqueo.status, 200);
  assert.equal(desbloqueo.body.tarea.bloqueo_motivo, undefined, 'al desbloquear se borra el motivo');
});

test('bloquear una tarea exige el motivo', async () => {
  montar();
  const tarea = await crear({ titulo: 'Instalar cámaras' });
  const r = await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'bloqueada' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /motivo/);
});

test('el cambio de estado y la reasignación quedan en el historial', async () => {
  montar();
  const tarea = await crear({ titulo: 'Colocar rótulo', proyecto_id: OBRA });
  await api('POST', `/api/tareas/${tarea.id_tarea}/estado`, { estado: 'en_curso' });
  await api('POST', `/api/tareas/${tarea.id_tarea}/reasignar`, { responsable_id: BEA.sub });

  assert.deepEqual(await accionesDe(tarea.id_tarea), ['reasignada', 'estado_cambiado', 'creada']);
});

// ─── Responsable único ───

test('reasignar cambia el responsable único y mueve la tarea de vista personal', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Cerrar el pedido', proyecto_id: OBRA, fecha_limite: dia(1) });

  // No basta ser quien la tiene asignada: la reasigna quien manda en el proyecto.
  assert.equal(
    (await api('POST', `/api/tareas/${tarea.id_tarea}/reasignar`, { responsable_id: CARLOS.sub }, BEA)).status,
    403,
  );

  const r = await api('POST', `/api/tareas/${tarea.id_tarea}/reasignar`, { responsable_id: BEA.sub });
  assert.equal(r.status, 200);
  assert.equal(r.body.tarea.responsable_id, BEA.sub);
  assert.equal(meta(db, tarea.id_tarea).vencimiento_orden, `${dia(1)}#${tarea.id_tarea}`);
  assert.equal(meta(db, tarea.id_tarea).responsables, undefined, 'no hay lista de responsables');

  assert.deepEqual((await api('GET', '/api/tareas/mias')).body.tareas, []);
  assert.deepEqual(
    (await api('GET', '/api/tareas/mias', undefined, BEA)).body.tareas.map((t) => t.id_tarea),
    [tarea.id_tarea],
  );

  const sinCambio = await api('POST', `/api/tareas/${tarea.id_tarea}/reasignar`, { responsable_id: BEA.sub });
  assert.equal(sinCambio.status, 409);
  assert.equal((await api('POST', `/api/tareas/${tarea.id_tarea}/reasignar`, {})).status, 400);
});

// ─── Lista de comprobación ───

test('completar toda la lista de comprobación no cierra la tarea', async () => {
  montar();
  const tarea = await crear({ titulo: 'Montar la terraza', proyecto_id: OBRA });

  const uno = await api('POST', `/api/tareas/${tarea.id_tarea}/checklist`, { texto: 'Pedir sombrillas' });
  const dos = await api('POST', `/api/tareas/${tarea.id_tarea}/checklist`, { texto: 'Montar mesas' });
  assert.equal(dos.status, 200);
  assert.equal(dos.body.tarea.checklist.length, 2);

  for (const respuesta of [uno, dos]) {
    const elemento = respuesta.body.tarea.checklist.at(-1);
    const marcado = await api('PATCH', `/api/tareas/${tarea.id_tarea}/checklist/${elemento.id}`, { hecho: true });
    assert.equal(marcado.status, 200);
  }

  const final = await api('GET', `/api/tareas/${tarea.id_tarea}`);
  assert.equal(final.body.tarea.checklist.every((e) => e.hecho), true);
  assert.equal(final.body.tarea.estado, 'pendiente', 'cerrar la tarea es una decisión de la persona');
  assert.equal(final.body.tarea.cerrada_en, undefined);
  assert.deepEqual(
    (await api('GET', '/api/tareas/mias')).body.tareas.map((t) => t.id_tarea),
    [tarea.id_tarea],
  );
});

test('desmarcar un elemento le quita quién y cuándo lo marcó', async () => {
  montar();
  const tarea = await crear({ titulo: 'Revisar extintores', checklist: ['Contar', 'Etiquetar'] });
  const elemento = tarea.checklist[0];

  const marcado = await api('PATCH', `/api/tareas/${tarea.id_tarea}/checklist/${elemento.id}`, { hecho: true });
  const marcadoItem = marcado.body.tarea.checklist.find((e) => e.id === elemento.id);
  assert.equal(marcadoItem.hecho_por, ANA.sub);
  assert.ok(marcadoItem.hecho_en);

  const desmarcado = await api('PATCH', `/api/tareas/${tarea.id_tarea}/checklist/${elemento.id}`, { hecho: false });
  const desmarcadoItem = desmarcado.body.tarea.checklist.find((e) => e.id === elemento.id);
  assert.equal(desmarcadoItem.hecho, false);
  assert.equal(desmarcadoItem.hecho_por, undefined);
});

test('la lista de comprobación tiene tope: por encima son subtareas', async () => {
  const db = montar();
  const llena = Array.from({ length: MAX_CHECKLIST }, (_, i) => `Paso ${i}`);
  const tarea = await crear({ titulo: 'Apertura del local', checklist: llena });
  assert.equal(tarea.checklist.length, MAX_CHECKLIST);

  const sobra = await api('POST', `/api/tareas/${tarea.id_tarea}/checklist`, { texto: 'Uno más' });
  assert.equal(sobra.status, 409);
  assert.match(sobra.body.error, /subtareas/);
  assert.equal(meta(db, tarea.id_tarea).checklist.length, MAX_CHECKLIST);

  const demasiados = await api('POST', '/api/tareas', {
    titulo: 'Otra',
    responsable_id: ANA.sub,
    checklist: [...llena, 'Uno más'],
  });
  assert.equal(demasiados.status, 400);
});

test('borrar y renombrar elementos de la lista, y un elemento inexistente da 404', async () => {
  montar();
  const tarea = await crear({ titulo: 'Cambiar la carta', checklist: ['Fotos', 'Precios'] });
  const [fotos, precios] = tarea.checklist;

  const renombrado = await api('PATCH', `/api/tareas/${tarea.id_tarea}/checklist/${fotos.id}`, {
    texto: 'Fotos nuevas',
  });
  assert.equal(renombrado.body.tarea.checklist.find((e) => e.id === fotos.id).texto, 'Fotos nuevas');

  const borrado = await api('DELETE', `/api/tareas/${tarea.id_tarea}/checklist/${precios.id}`);
  assert.deepEqual(borrado.body.tarea.checklist.map((e) => e.id), [fotos.id]);

  assert.equal((await api('DELETE', `/api/tareas/${tarea.id_tarea}/checklist/inventado`)).status, 404);
  assert.equal((await api('POST', `/api/tareas/${tarea.id_tarea}/checklist`, { texto: '  ' })).status, 400);
});

// ─── Comentarios ───

test('un comentario guarda sus menciones y deja al mencionado leer la tarea', async () => {
  montar();
  const tarea = await crear({ titulo: 'Preparar la inauguración', proyecto_id: SECRETO });
  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA)).status, 404);

  const comentario = await api('POST', `/api/tareas/${tarea.id_tarea}/comentarios`, {
    texto: 'Que lo confirme @000002, es cosa suya',
  });
  assert.equal(comentario.status, 200);
  assert.deepEqual(comentario.body.comentario.menciones, [BEA.sub]);
  assert.equal(comentario.body.comentario.autor_nombre, 'Ana Ruiz');

  // La mención se acumula en la tarea: si viviera solo en el comentario, quien
  // está mencionado no podría entrar a leerlo.
  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA)).status, 200);
  const hilo = await api('GET', `/api/tareas/${tarea.id_tarea}/comentarios`, undefined, BEA);
  assert.equal(hilo.body.comentarios.length, 1);

  // Leer el hilo no da derecho a escribir en él.
  assert.equal(
    (await api('POST', `/api/tareas/${tarea.id_tarea}/comentarios`, { texto: 'Vale' }, BEA)).status,
    403,
  );
  assert.equal((await api('POST', `/api/tareas/${tarea.id_tarea}/comentarios`, { texto: '' })).status, 400);
});

test('los comentarios salen del más reciente al más antiguo y paginan', async () => {
  montar({ paginaTam: 2 });
  const tarea = await crear({ titulo: 'Repasar la obra' });
  for (const texto of ['uno', 'dos', 'tres', 'cuatro']) {
    await api('POST', `/api/tareas/${tarea.id_tarea}/comentarios`, { texto });
  }

  const primera = await api('GET', `/api/tareas/${tarea.id_tarea}/comentarios`);
  assert.deepEqual(primera.body.comentarios.map((c) => c.texto), ['cuatro', 'tres']);
  assert.ok(primera.body.cursor);

  const segunda = await api(
    'GET',
    `/api/tareas/${tarea.id_tarea}/comentarios?cursor=${encodeURIComponent(primera.body.cursor)}`,
  );
  assert.deepEqual(segunda.body.comentarios.map((c) => c.texto), ['dos', 'uno']);
});

// ─── Creación en lote ───

test('el lote con una tarea inválida no crea ninguna y dice qué falla en cada índice', async () => {
  const db = montar();
  const r = await api('POST', '/api/tareas/lote', {
    proyecto_id: OBRA,
    tareas: [
      { titulo: 'Pedir presupuestos', responsable_id: ANA.sub },
      { titulo: 'Sin responsable' },
      { titulo: '', responsable_id: ANA.sub },
      { titulo: 'Prioridad rara', responsable_id: ANA.sub, prioridad: 'urgentísima' },
    ],
  });

  assert.equal(r.status, 400);
  assert.deepEqual(r.body.fallos.map((f) => f.indice), [1, 2, 3]);
  assert.match(r.body.fallos[0].error, /responsable/);
  assert.match(r.body.fallos[2].error, /Prioridad/);
  assert.equal(db.listar(tables.tareas).length, 0, 'validación previa de todas: no se escribe ninguna');
});

test('repetir el lote con el mismo propuesta_origen_id no duplica: devuelve la existente', async () => {
  const db = montar();
  const cuerpo = {
    proyecto_id: OBRA,
    tareas: [
      { titulo: 'Comprar sillas', responsable_id: ANA.sub, propuesta_origen_id: 'prop-1', cita_origen: 'Compramos sillas' },
      { titulo: 'Pedir presupuesto de luces', responsable_id: BEA.sub, propuesta_origen_id: 'prop-2' },
    ],
  };

  const primera = await api('POST', '/api/tareas/lote', cuerpo);
  assert.equal(primera.status, 200);
  assert.equal(primera.body.creadas.length, 2);
  assert.deepEqual(primera.body.omitidas, []);
  assert.equal(primera.body.creadas[0].cita_origen, 'Compramos sillas');
  assert.equal(primera.body.creadas[0].departamento_id, 'dep-obras', 'el departamento se hereda del proyecto');

  // La doble pulsación de «validar» es el caso real que esto evita.
  const segunda = await api('POST', '/api/tareas/lote', cuerpo);
  assert.equal(segunda.status, 200);
  assert.deepEqual(segunda.body.creadas, []);
  assert.deepEqual(segunda.body.omitidas.map((o) => o.propuesta_origen_id), ['prop-1', 'prop-2']);
  assert.deepEqual(
    segunda.body.omitidas.map((o) => o.tarea.id_tarea),
    primera.body.creadas.map((t) => t.id_tarea),
  );
  assert.equal(db.listar(tables.tareas).length, 2);

  // Dos entradas del mismo lote con la misma propuesta tampoco se duplican.
  const dentro = await api('POST', '/api/tareas/lote', {
    proyecto_id: OBRA,
    tareas: [
      { titulo: 'Una', responsable_id: ANA.sub, propuesta_origen_id: 'prop-3' },
      { titulo: 'La misma', responsable_id: ANA.sub, propuesta_origen_id: 'prop-3' },
    ],
  });
  assert.equal(dentro.body.creadas.length, 1);
  assert.equal(dentro.body.omitidas.length, 1);
  assert.equal(db.listar(tables.tareas).length, 3);
});

test('el lote escribe en tandas de 25 y registra la actividad de todas', async () => {
  const db = montar();
  const tareas = Array.from({ length: 30 }, (_, i) => ({
    titulo: `Punto ${i}`,
    responsable_id: ANA.sub,
  }));
  const r = await api('POST', '/api/tareas/lote', { proyecto_id: OBRA, tareas });

  assert.equal(r.status, 200);
  assert.equal(r.body.creadas.length, 30);
  assert.equal(db.listar(tables.tareas).length, 30);
  assert.equal(
    db.operaciones.filter((o) => o.tipo === 'BatchWriteCommand').length,
    4,
    'dos tandas de tareas y dos de actividad',
  );
  assert.equal(db.listar(tables.actividad).length, 30);
});

test('el lote respeta el tope y exige al menos una tarea', async () => {
  montar();
  const demasiadas = Array.from({ length: 51 }, () => ({ titulo: 'X', responsable_id: ANA.sub }));
  const tope = await api('POST', '/api/tareas/lote', { proyecto_id: OBRA, tareas: demasiadas });
  assert.equal(tope.status, 400);
  assert.match(tope.body.error, /más de 50/);

  assert.equal((await api('POST', '/api/tareas/lote', { tareas: [] })).status, 400);
  assert.equal((await api('POST', '/api/tareas/lote', {})).status, 400);
});

test('una propuesta sin proyecto ni reunión de origen no se puede comprobar, y se dice', async () => {
  const db = montar();
  // Sin una de las dos particiones no hay índice por el que saber si la propuesta
  // ya se convirtió, y resolverlo con un Scan no es una opción.
  const r = await api('POST', '/api/tareas/lote', {
    tareas: [{ titulo: 'Suelta', responsable_id: ANA.sub, propuesta_origen_id: 'prop-9' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /proyecto o la reunión/);
  assert.equal(db.listar(tables.tareas).length, 0);
});

test('el lote de una reunión no duplica aunque no venga con proyecto', async () => {
  const db = montar();
  const cuerpo = {
    reunion_origen_id: 'reu-7',
    tareas: [{ titulo: 'Traer datos de ventas', responsable_id: ANA.sub, propuesta_origen_id: 'prop-r1' }],
  };
  assert.equal((await api('POST', '/api/tareas/lote', cuerpo)).body.creadas.length, 1);
  const segunda = await api('POST', '/api/tareas/lote', cuerpo);
  assert.deepEqual(segunda.body.creadas, []);
  assert.equal(segunda.body.omitidas.length, 1);
  assert.equal(db.listar(tables.tareas).length, 1);
});

// ─── Listado ───

test('filtrar un listado de veinte tareas de varios proyectos no hace una lectura por tarea', async () => {
  const db = montar();
  for (let p = 0; p < 5; p += 1) {
    sembrarProyecto(db, { id: `p${p}`, nombre: `Proyecto ${p}`, responsable_id: BEA.sub });
    for (let t = 0; t < 4; t += 1) {
      sembrarTarea(db, {
        id_tarea: `p${p}-t${t}`,
        titulo: `Tarea ${t} de ${p}`,
        responsable_id: ANA.sub,
        proyecto_id: `p${p}`,
        fecha_limite: dia(t + 1),
      });
    }
  }
  const antes = db.operaciones.length;

  const r = await api('GET', `/api/tareas?responsable=${ANA.sub}`, undefined, DORA);
  assert.equal(r.status, 200);
  assert.equal(r.body.tareas.length, 20);

  const nuevas = db.operaciones.slice(antes);
  const lotes = nuevas.filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(
    lotes.length,
    2,
    'los cinco proyectos de la página de una vez, y los nombres en otro lote',
  );
  assert.equal(lotes[1].claves, 1, 'las veinte tareas son de una sola persona: una clave');
  assert.equal(
    nuevas.filter((o) => o.tipo === 'QueryCommand' && o.tabla === tables.proyectos).length,
    0,
    'nada de una Query por tarea para saber si se puede ver',
  );
  assert.equal(
    nuevas.filter((o) => o.tipo === 'QueryCommand' && o.tabla === tables.tareas).length,
    1,
  );
});

test('el listado filtra por estado y por departamento, y las abiertas van antes en el proyecto', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 'a',
    titulo: 'Abierta',
    responsable_id: ANA.sub,
    proyecto_id: OBRA,
    departamento_id: 'dep-obras',
    fecha_limite: dia(9),
  });
  sembrarTarea(db, {
    id_tarea: 'b',
    titulo: 'En curso',
    responsable_id: BEA.sub,
    proyecto_id: OBRA,
    departamento_id: 'dep-sala',
    estado: 'en_curso',
    fecha_limite: dia(1),
  });
  sembrarTarea(db, {
    id_tarea: 'c',
    titulo: 'Hecha',
    responsable_id: ANA.sub,
    proyecto_id: OBRA,
    departamento_id: 'dep-obras',
    estado: 'hecha',
    fecha_limite: dia(-4),
  });

  const todas = await api('GET', `/api/tareas?proyecto=${OBRA}`);
  assert.deepEqual(todas.body.tareas.map((t) => t.id_tarea), ['b', 'a', 'c']);

  const enCurso = await api('GET', `/api/tareas?proyecto=${OBRA}&estado=en_curso`);
  assert.deepEqual(enCurso.body.tareas.map((t) => t.id_tarea), ['b']);

  const porDepartamento = await api('GET', `/api/tareas?proyecto=${OBRA}&departamento=dep-obras`);
  assert.deepEqual(porDepartamento.body.tareas.map((t) => t.id_tarea), ['a', 'c']);

  const porPersona = await api('GET', `/api/tareas?proyecto=${OBRA}&responsable=${BEA.sub}`);
  assert.deepEqual(porPersona.body.tareas.map((t) => t.id_tarea), ['b']);
});

test('el listado exige proyecto o persona: no hay índice de todas las tareas', async () => {
  montar();
  const sinFiltro = await api('GET', '/api/tareas');
  assert.equal(sinFiltro.status, 400);
  assert.match(sinFiltro.body.error, /proyecto o la persona/);

  const estadoInventado = await api('GET', `/api/tareas?proyecto=${OBRA}&estado=terminada`);
  assert.equal(estadoInventado.status, 400);

  // El índice por persona solo tiene abiertas: pedir el histórico por ahí
  // devolvería una lista vacía indistinguible de «no hay ninguna».
  const historico = await api('GET', `/api/tareas?responsable=${ANA.sub}&estado=hecha`);
  assert.equal(historico.status, 400);
  assert.match(historico.body.error, /por proyecto/);
});

// ─── Nombres y permisos de fila ───

test('la vista personal trae el nombre del proyecto y el de quien pregunta sin leer usuarios', async () => {
  const db = montar();
  const conProyecto = await crear({ titulo: 'Pedir taburetes', proyecto_id: OBRA, fecha_limite: dia(3) });
  const suelta = await crear({ titulo: 'Llamar al gestor' });
  const antes = db.operaciones.length;

  const r = await api('GET', '/api/tareas/mias');
  assert.equal(r.status, 200);
  const porId = Object.fromEntries(r.body.tareas.map((t) => [t.id_tarea, t]));
  assert.equal(porId[conProyecto.id_tarea].proyecto_nombre, 'Reforma de la barra');
  assert.equal(porId[conProyecto.id_tarea].responsable_nombre, 'Ana Ruiz');
  // Sin proyecto no hay nombre de proyecto, igual que no hay `proyecto_id`.
  assert.equal('proyecto_nombre' in porId[suelta.id_tarea], false);
  assert.equal(porId[suelta.id_tarea].responsable_nombre, 'Ana Ruiz');

  // En la vista personal la responsable es siempre quien pregunta y su nombre ya
  // viene en el contexto de acceso: aquí no se toca `igp_usuarios` ni en lote.
  const nuevas = db.operaciones.slice(antes);
  assert.equal(
    nuevas.filter((o) => o.tipo === 'BatchGetCommand').length,
    1,
    'solo el lote de proyectos que ya se leía para filtrar la visibilidad',
  );
  assert.equal(
    nuevas.filter((o) => o.tabla === tables.usuarios).length,
    0,
    'ni una lectura de usuarios para resolver el nombre propio',
  );
});

test('el listado resuelve los nombres de varias personas en un solo lote', async () => {
  const db = montar();
  [ANA, BEA, ANA, BEA, ANA].forEach((persona, i) => {
    sembrarTarea(db, {
      id_tarea: `t${i}`,
      titulo: `Tarea ${i}`,
      responsable_id: persona.sub,
      proyecto_id: OBRA,
      fecha_limite: dia(i + 1),
    });
  });
  // Una primera llamada deja el contexto de acceso en caché: su lectura del
  // usuario no es del listado y ensuciaría la cuenta.
  await api('GET', `/api/tareas?proyecto=${OBRA}`);
  const antes = db.operaciones.length;

  const r = await api('GET', `/api/tareas?proyecto=${OBRA}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.tareas.length, 5);
  assert.deepEqual(
    [...new Set(r.body.tareas.map((t) => t.responsable_nombre))].sort(),
    ['Ana Ruiz', 'Bea Soler'],
  );
  assert.equal(
    r.body.tareas.every((t) => t.proyecto_nombre === 'Reforma de la barra'),
    true,
    'el nombre del proyecto sale del mapa que ya se cargó, no de una lectura por tarea',
  );

  const nuevas = db.operaciones.slice(antes);
  const lotes = nuevas.filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(lotes.length, 2, 'el proyecto de la página en un lote y los nombres en otro');
  assert.equal(lotes[1].claves, 2, 'cinco tareas de dos personas son dos claves, no cinco');
  assert.equal(
    nuevas.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.usuarios).length,
    0,
    'nada de una lectura por fila',
  );
});

test('un responsable que ya no existe deja responsable_nombre en null sin romper nada', async () => {
  const db = montar();
  // No hay integridad referencial contra `igp_usuarios`: el identificador puede
  // apuntar a alguien dado de baja y la pantalla tiene que seguir pintándose.
  sembrarTarea(db, {
    id_tarea: 't-fantasma',
    titulo: 'Cerrar el alta del proveedor',
    responsable_id: '000404',
    proyecto_id: OBRA,
    fecha_limite: dia(1),
  });

  const lista = await api('GET', `/api/tareas?proyecto=${OBRA}`);
  assert.equal(lista.status, 200);
  assert.equal(lista.body.tareas[0].responsable_nombre, null);

  const ficha = await api('GET', '/api/tareas/t-fantasma');
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.tarea.responsable_nombre, null);
  assert.equal(ficha.body.tarea.proyecto_nombre, 'Reforma de la barra');
});

test('permisos_fila dice lo que cada persona puede hacer con la tarea', async () => {
  montar();
  const tarea = await crear({ titulo: 'Colocar la barra', proyecto_id: OBRA, responsable_id: BEA.sub });

  // Ana dirige el proyecto: edita y reasigna por su rol, y borra porque tiene
  // `proyectos.borrar`.
  const deAna = await api('GET', `/api/tareas/${tarea.id_tarea}`);
  assert.deepEqual(deAna.body.tarea.permisos_fila, {
    editar: true,
    reasignar: true,
    borrar: true,
    crear_subtarea: true,
  });

  // Bea la tiene asignada: la edita, pero no se la quita de encima ella sola ni
  // la borra. Y **no** puede colgarle subtareas: eso decide el proyecto, del que
  // no es miembro. Si `crear_subtarea` copiara a `editar`, la pantalla le pintaría
  // un botón que `POST /api/tareas` rechaza con un 403.
  const deBea = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA);
  assert.deepEqual(deBea.body.tarea.permisos_fila, {
    editar: true,
    reasignar: false,
    borrar: false,
    crear_subtarea: false,
  });

  // Dora la alcanza por `tareas.ver_todas` y nada más.
  const deDora = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, DORA);
  assert.deepEqual(deDora.body.tarea.permisos_fila, {
    editar: false,
    reasignar: false,
    borrar: false,
    crear_subtarea: false,
  });

  // Y lo mismo en el listado, que es donde la interfaz decide qué botones pinta.
  const listado = await api('GET', `/api/tareas?proyecto=${OBRA}`, undefined, BEA);
  assert.deepEqual(listado.body.tareas[0].permisos_fila, {
    editar: true,
    reasignar: false,
    borrar: false,
    crear_subtarea: false,
  });
});

test('crear_subtarea coincide con lo que acepta POST /api/tareas', async () => {
  // La regla que fija esta prueba es de coherencia: el permiso de fila y el
  // autorizador tienen que decir lo mismo, porque si no la interfaz ofrece
  // acciones que el servidor rechaza. Ya pasó con `editar` en los proyectos.
  montar();
  const tarea = await crear({ titulo: 'Colocar la barra', proyecto_id: OBRA, responsable_id: BEA.sub });

  for (const usuario of [ANA, BEA, DORA]) {
    const ficha = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, usuario);
    const anunciado = ficha.body.tarea.permisos_fila.crear_subtarea;

    const alta = await api('POST', '/api/tareas', {
      titulo: 'Atornillar el pie',
      responsable_id: usuario.sub,
      proyecto_id: OBRA,
      tarea_padre_id: tarea.id_tarea,
    }, usuario);

    assert.equal(
      alta.status === 200,
      anunciado,
      `${usuario.sub}: la ficha anuncia ${anunciado} y el alta responde ${alta.status}`,
    );
  }
});

test('permisos_fila de una tarea suelta la deja en manos de quien la creó', async () => {
  montar();
  const tarea = await crear({ titulo: 'Repasar el seguro', responsable_id: BEA.sub }, ANA);

  const deAna = await api('GET', `/api/tareas/${tarea.id_tarea}`);
  assert.equal(deAna.body.tarea.permisos_fila.editar, true, 'la creó ella');
  const deBea = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA);
  assert.equal(deBea.body.tarea.permisos_fila.editar, true, 'la tiene asignada');
  const deEva = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, EVA);
  assert.equal(deEva.status, 404, 'una tarea suelta no la ve nadie más');
});

// ─── Subtareas y borrado ───

test('una subtarea hereda el proyecto de su madre y sale por el índice de padre', async () => {
  montar();
  const madre = await crear({ titulo: 'Reforma del baño', proyecto_id: OBRA });
  const hija = await crear({ titulo: 'Cambiar los grifos', tarea_padre_id: madre.id_tarea });

  assert.equal(hija.proyecto_id, OBRA);
  assert.equal(hija.departamento_id, 'dep-obras');

  const r = await api('GET', `/api/tareas/${madre.id_tarea}/subtareas`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tareas.map((t) => t.id_tarea), [hija.id_tarea]);

  const inventada = await api('POST', '/api/tareas', {
    titulo: 'Huérfana',
    responsable_id: ANA.sub,
    tarea_padre_id: 'no-existe',
  });
  assert.equal(inventada.status, 400);
});

test('no se borra una tarea con subtareas abiertas; cerradas, se lleva su partición entera', async () => {
  const db = montar();
  const madre = await crear({ titulo: 'Obra del almacén', proyecto_id: OBRA });
  const hija = await crear({ titulo: 'Tirar el tabique', tarea_padre_id: madre.id_tarea });
  await api('POST', `/api/tareas/${madre.id_tarea}/comentarios`, { texto: 'Empezamos el lunes' });

  const conAbiertas = await api('DELETE', `/api/tareas/${madre.id_tarea}`);
  assert.equal(conAbiertas.status, 409);
  assert.match(conAbiertas.body.error, /sin cerrar/);
  assert.ok(meta(db, madre.id_tarea));

  await api('POST', `/api/tareas/${hija.id_tarea}/estado`, { estado: 'cancelada' });
  const r = await api('DELETE', `/api/tareas/${madre.id_tarea}`);
  assert.equal(r.status, 200);
  assert.equal(meta(db, madre.id_tarea), null);
  assert.equal(
    db.listar(tables.tareas).filter((it) => it.PK === PK.tarea(madre.id_tarea)).length,
    0,
    'los comentarios se van con la tarea',
  );
  // El historial es append-only: la traza del borrado se queda.
  assert.ok(db.listar(tables.actividad).some((a) => a.accion === 'borrada'));
  assert.equal((await api('GET', `/api/tareas/${madre.id_tarea}`)).status, 404);
});

test('borrar exige proyectos.borrar y no alcanza tareas que no se ven', async () => {
  montar();
  const tarea = await crear({ titulo: 'Dar de baja la línea', proyecto_id: SECRETO });
  assert.equal((await api('DELETE', `/api/tareas/${tarea.id_tarea}`, undefined, BEA)).status, 403);
  // Dora tiene `tareas.ver_todas` pero no `proyectos.borrar`.
  assert.equal((await api('DELETE', `/api/tareas/${tarea.id_tarea}`, undefined, DORA)).status, 403);
});

test('borrar una tarea se lleva sus objetos de S3, y un fallo del bucket no la deja sin borrar', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Comprar taburetes', proyecto_id: OBRA });
  const claveAdjunto = `tasks/tareas/${tarea.id_tarea}/adjuntos/a1-presupuesto.pdf`;
  const claveImagen = `tasks/tareas/${tarea.id_tarea}/enlaces/e1.png`;
  db.sembrar(tables.tareas, {
    PK: PK.tarea(tarea.id_tarea),
    SK: SK.adjunto('a1'),
    id_adjunto: 'a1',
    s3_key: claveAdjunto,
  });
  db.sembrar(tables.tareas, {
    PK: PK.tarea(tarea.id_tarea),
    SK: SK.enlace('e1'),
    id_enlace: 'e1',
    imagen_s3_key: claveImagen,
  });
  // Un enlace cuya captura falló no tiene imagen: no hay nada que borrar y no se
  // intenta.
  db.sembrar(tables.tareas, {
    PK: PK.tarea(tarea.id_tarea),
    SK: SK.enlace('e2'),
    id_enlace: 'e2',
    captura_estado: 'fallida',
  });

  const pedidos = [];
  const restaurarAdjuntos = configurarAlmacenAdjuntos({
    borrar: async ({ key }) => {
      pedidos.push(key);
    },
  });
  // La imagen del enlace falla: el borrado de la tarea tiene que salir igual.
  const restaurarEnlaces = configurarTransporteEnlaces({
    borrarImagen: async ({ key }) => {
      pedidos.push(key);
      throw new Error('AccessDenied');
    },
  });
  try {
    const r = await api('DELETE', `/api/tareas/${tarea.id_tarea}`);
    assert.equal(r.status, 200);
  } finally {
    restaurarAdjuntos();
    restaurarEnlaces();
  }

  assert.deepEqual(pedidos.sort(), [claveAdjunto, claveImagen].sort());
  assert.equal(
    db.listar(tables.tareas).filter((it) => it.PK === PK.tarea(tarea.id_tarea)).length,
    0,
    'un objeto inaccesible en S3 dejaría una tarea que nadie puede borrar nunca',
  );
});

// ─── Edición ───

test('editar la fecha límite reordena la vista personal y queda el antes y el después', async () => {
  const db = montar();
  const pronto = await crear({ titulo: 'Pedir vasos', fecha_limite: dia(2) });
  const tarde = await crear({ titulo: 'Pedir manteles', fecha_limite: dia(20) });

  const r = await api('PATCH', `/api/tareas/${tarde.id_tarea}`, { fecha_limite: dia(1) });
  assert.equal(r.status, 200);
  assert.equal(meta(db, tarde.id_tarea).vencimiento_orden, `${dia(1)}#${tarde.id_tarea}`);

  const orden = await api('GET', '/api/tareas/mias');
  assert.deepEqual(orden.body.tareas.map((t) => t.id_tarea), [tarde.id_tarea, pronto.id_tarea]);

  const historial = await api('GET', `/api/tareas/${tarde.id_tarea}/actividad`);
  const edicion = historial.body.actividad.find((a) => a.accion === 'editada');
  assert.deepEqual(JSON.parse(edicion.detalle), {
    antes: { fecha_limite: dia(20) },
    despues: { fecha_limite: dia(1) },
  });
});

test('quitar la fecha límite deja la tarea al final, no fuera del índice', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Cambiar la rotulación', fecha_limite: dia(3) });
  await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { fecha_limite: '' });

  assert.equal(meta(db, tarea.id_tarea).fecha_limite, undefined);
  assert.equal(meta(db, tarea.id_tarea).vencimiento_orden, `9999-12-31#${tarea.id_tarea}`);
  assert.deepEqual(
    (await api('GET', '/api/tareas/mias')).body.tareas.map((t) => t.id_tarea),
    [tarea.id_tarea],
  );
});

test('el PATCH valida y no acepta campos que no son suyos', async () => {
  montar();
  const tarea = await crear({ titulo: 'Revisar la cámara', proyecto_id: OBRA });

  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { titulo: '  ' })).status, 400);
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { fecha_limite: '30/09/2026' })).status, 400);
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { prioridad: 'ninguna' })).status, 400);
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, {})).status, 400);
  // El estado y el responsable tienen su propia ruta.
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { estado: 'hecha' })).status, 400);
  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`)).body.tarea.estado, 'pendiente');
});

test('una tarea que no existe da 404 en todas sus rutas', async () => {
  montar();
  assert.equal((await api('GET', '/api/tareas/fantasma')).status, 404);
  assert.equal((await api('PATCH', '/api/tareas/fantasma', { titulo: 'X' })).status, 404);
  assert.equal((await api('POST', '/api/tareas/fantasma/estado', { estado: 'hecha' })).status, 404);
  assert.equal((await api('POST', '/api/tareas/fantasma/reasignar', { responsable_id: BEA.sub })).status, 404);
  assert.equal((await api('DELETE', '/api/tareas/fantasma')).status, 404);
  assert.equal((await api('GET', '/api/tareas/fantasma/subtareas')).status, 404);
  assert.equal((await api('GET', '/api/tareas/fantasma/actividad')).status, 404);
  assert.equal((await api('GET', '/api/tareas/fantasma/comentarios')).status, 404);
});

// ─── Creación ───

test('crear exige título y responsable, y hereda el departamento del proyecto', async () => {
  const db = montar();
  assert.equal((await api('POST', '/api/tareas', { responsable_id: ANA.sub })).status, 400);
  assert.equal((await api('POST', '/api/tareas', { titulo: 'Sin nadie' })).status, 400);
  assert.equal(db.listar(tables.tareas).length, 0);

  const tarea = await crear({ titulo: 'Colocar la barra', proyecto_id: OBRA });
  assert.equal(tarea.departamento_id, 'dep-obras');
  assert.equal(tarea.estado, 'pendiente');
  assert.equal(tarea.prioridad, 'media');
  assert.equal(tarea.creado_por, ANA.sub);
  assert.deepEqual(tarea.checklist, []);
  assert.deepEqual(await accionesDe(tarea.id_tarea), ['creada']);

  // El departamento es etiqueta organizativa: se puede cambiar a otro.
  const cambio = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { departamento_id: 'dep-contabilidad' });
  assert.equal(cambio.body.tarea.departamento_id, 'dep-contabilidad');
});

test('no se crean tareas en un proyecto que no se ve ni en uno que no se puede editar', async () => {
  const db = montar();
  // Eva tiene `proyectos.editar` pero no participa en la obra: para ella no existe.
  const ajeno = await api('POST', '/api/tareas', {
    titulo: 'Colarse',
    responsable_id: EVA.sub,
    proyecto_id: OBRA,
  }, EVA);
  assert.equal(ajeno.status, 404, 'un 403 confirmaría que el proyecto existe');

  // En el otro sí es observadora: lo ve, y precisamente por eso el no es un 403.
  const observadora = await api('POST', '/api/tareas', {
    titulo: 'Mirar y callar',
    responsable_id: EVA.sub,
    proyecto_id: SECRETO,
  }, EVA);
  assert.equal(observadora.status, 403);
  assert.match(observadora.body.error, /No puedes crear tareas/);

  const inventado = await api('POST', '/api/tareas', {
    titulo: 'En la nada',
    responsable_id: ANA.sub,
    proyecto_id: 'no-existe',
  });
  assert.equal(inventado.status, 404);
  assert.equal(db.listar(tables.tareas).length, 0);
});

test('una tarea suelta la ve y la edita quien la creó', async () => {
  montar();
  const tarea = await crear({ titulo: 'Llamar al gestor', responsable_id: BEA.sub });
  assert.equal(tarea.proyecto_id, undefined, 'sin proyecto no se escribe el atributo');

  const r = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { descripcion: 'Antes del día 5' });
  assert.equal(r.status, 200);
  // Y su responsable también, aunque no la creara.
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { prioridad: 'alta' }, BEA)).status, 200);
  // Alguien ajeno, no.
  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, DORA)).status, 200);
  assert.equal((await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { prioridad: 'baja' }, DORA)).status, 403);
});

test('el responsable del proyecto crea tareas en él sin tener proyectos.editar', async () => {
  // Bea solo tiene `proyectos.ver`. Dirigir el proyecto es lo que la habilita, y
  // por eso la ruta no exige el permiso global: lo decide la ACL de fila.
  const db = montar();
  sembrarProyecto(db, {
    id: 'p-bea',
    nombre: 'Terraza de verano',
    responsable_id: BEA.sub,
    miembros: [{ usuario_id: BEA.sub, rol_proyecto: 'responsable' }],
  });

  const r = await api('POST', '/api/tareas', {
    titulo: 'Pedir sombrillas',
    responsable_id: BEA.sub,
    proyecto_id: 'p-bea',
  }, BEA);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tarea.proyecto_id, 'p-bea');
  assert.equal(r.body.tarea.permisos_fila.editar, true, 'y lo que dice la ficha se cumple');

  // Y sigue sin poder crear en el proyecto de otro en el que solo es miembro.
  const ajena = await api('POST', '/api/tareas', {
    titulo: 'Colarse',
    responsable_id: BEA.sub,
    proyecto_id: OBRA,
  }, BEA);
  assert.equal(ajena.status, 403);
});

test('la tarea suelta sí exige proyectos.editar: sin proyecto no hay fila que decida', async () => {
  const db = montar();
  const sinPermiso = await api('POST', '/api/tareas', { titulo: 'Suelta', responsable_id: ANA.sub }, BEA);
  assert.equal(sinPermiso.status, 403);
  assert.match(sinPermiso.body.error, /sin proyecto/);
  assert.equal(db.listar(tables.tareas).length, 0);

  // Y una subtarea de una tarea suelta hereda ese mismo criterio.
  const madre = await crear({ titulo: 'Papeleo del gestor' });
  const hija = await api('POST', '/api/tareas', {
    titulo: 'Recoger los modelos',
    responsable_id: ANA.sub,
    tarea_padre_id: madre.id_tarea,
  }, BEA);
  assert.equal(hija.status, 403);
});

// ─── Lo que no se ve tampoco se nombra ───

test('proyecto_nombre llega null cuando la tarea se ve pero su proyecto no', async () => {
  montar();
  // Bea no participa en el proyecto secreto; la tarea la ve porque es la
  // responsable. El nombre del proyecto es un dato en sí mismo.
  const tarea = await crear({
    titulo: 'Preparar la documentación',
    proyecto_id: SECRETO,
    responsable_id: BEA.sub,
    fecha_limite: dia(2),
  });

  const ficha = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA);
  assert.equal(ficha.status, 200, 'su tarea sí la ve');
  assert.equal(ficha.body.tarea.proyecto_nombre, null);
  assert.equal(ficha.body.tarea.proyecto_id, SECRETO, 'el id sigue viajando: la pantalla lo necesita');

  const mias = await api('GET', '/api/tareas/mias', undefined, BEA);
  assert.equal(mias.body.tareas[0].proyecto_nombre, null);

  // Si pulsa para abrirlo, 404. Y quien sí alcanza el proyecto lee su nombre.
  const deAna = await api('GET', `/api/tareas/${tarea.id_tarea}`);
  assert.equal(deAna.body.tarea.proyecto_nombre, 'Nuevo local');
  // Dora llega por `tareas.ver_todas`, que también da acceso al proyecto.
  const deDora = await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, DORA);
  assert.equal(deDora.body.tarea.proyecto_nombre, 'Nuevo local');
});

test('leer el hilo de comentarios exige el permiso del módulo, como sus cinco hermanas', async () => {
  montar();
  const tarea = await crear({ titulo: 'Repasar la obra', proyecto_id: OBRA });
  assert.equal(
    (await api('GET', `/api/tareas/${tarea.id_tarea}/comentarios`, undefined, CARLOS)).status,
    403,
  );
});

// ─── Historial y concurrencia ───

test('el lote firma el historial con el nombre de quien lo lanzó, no solo con su id', async () => {
  const db = montar();
  const r = await api('POST', '/api/tareas/lote', {
    proyecto_id: OBRA,
    tareas: [
      { titulo: 'Pedir presupuestos', responsable_id: ANA.sub },
      { titulo: 'Cerrar el calendario', responsable_id: BEA.sub },
    ],
  });
  assert.equal(r.status, 200);

  const entradas = db.listar(tables.actividad);
  assert.equal(entradas.length, 2);
  for (const entrada of entradas) {
    assert.equal(entrada.usuario_id, ANA.sub);
    // En Fase 2 este es el camino normal: toda tarea nacida de una reunión entra
    // por el lote, y un historial con el id crudo no dice quién fue.
    assert.equal(entrada.usuario_nombre, 'Ana Ruiz');
  }
});

test('una tarea borrada entre la comprobación y la escritura responde 404, no 500', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Cambiar la instalación', proyecto_id: OBRA });

  // Otra persona la borra justo después de que la comprobación de acceso la haya
  // leído: la escritura condicional falla y eso es un 404, que es lo que la
  // interfaz sabe tratar.
  db.interceptar('UpdateCommand', tables.tareas, async () => {
    await docClient.send(
      new (await import('@aws-sdk/lib-dynamodb')).DeleteCommand({
        TableName: tables.tareas,
        Key: { PK: PK.tarea(tarea.id_tarea), SK: SK.meta },
      }),
    );
  });

  const r = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { titulo: 'Otro título' });
  assert.equal(r.status, 404);
  assert.equal(meta(db, tarea.id_tarea), null);
});

test('las @menciones de la descripción se extraen también al editar la tarea', async () => {
  const db = montar();
  const tarea = await crear({ titulo: 'Revisar el contrato', proyecto_id: OBRA });
  assert.deepEqual(tarea.menciones, []);

  // Sin `menciones` en el cuerpo: la descripción es la única fuente, igual que al
  // crear la tarea.
  const r = await api('PATCH', `/api/tareas/${tarea.id_tarea}`, {
    descripcion: 'Que lo mire @000002 antes del viernes',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tarea.menciones, [BEA.sub]);
  // Y la mención da lectura, que es para lo que sirve guardarla.
  assert.equal((await api('GET', `/api/tareas/${tarea.id_tarea}`, undefined, BEA)).status, 200);

  // Editar la descripción no echa a quien fue mencionado en un comentario.
  await api('POST', `/api/tareas/${tarea.id_tarea}/comentarios`, { texto: 'Ojo @000004' });
  await api('PATCH', `/api/tareas/${tarea.id_tarea}`, { descripcion: 'Sin nadie citado' });
  assert.deepEqual(meta(db, tarea.id_tarea).menciones.sort(), [BEA.sub, DORA.sub].sort());
});
