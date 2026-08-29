/**
 * Fase 3 backend: notificaciones (campana) + feed ICS de vencimientos.
 *
 * Fija:
 * - crear / listar / contar no leídas (GSI, sin Scan) / marcar leídas
 * - idempotencia de vencimiento por entidad_ref+día
 * - ICS sin DESCRIPTION; rotar token invalida el anterior
 * - mención y asignación emiten notificaciones
 * - Directory stub no toca usuarios
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.LOG_LEVEL = 'silent';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { crearContextoAcceso, invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK, vencimientoOrdenDe, TIPOS_NOTIFICACION } = await import('../lib/tasks/tipos.js');
const {
  crearNotificacion,
  listarNotificaciones,
  contarNoLeidas,
  marcarLeidas,
  IDX_NO_LEIDAS,
} = await import('../lib/tasks/notificaciones.js');
const {
  rotarTokenIcs,
  validarTokenIcs,
  hashTokenIcs,
  construirIcs,
  feedVencimientosIcs,
  tareasAbiertasConVencimiento,
  ICS_AJUSTE_PK,
  ICS_TOKEN_SK_PREFIJO,
} = await import('../lib/tasks/vencimientosIcs.js');
const { crearTarea, reasignarTarea, crearComentario } = await import('../lib/tasks/tareas.js');
const { enviarAvisosVencimiento, AVISOS_AJUSTE_PK, AVISOS_AJUSTE_SK } = await import('../lib/tasks/avisos.js');
const directory = await import('../lib/google/directoryClient.js');

const ANA = {
  id_usuario: '000001',
  Email: 'ana@grupo.test',
  Nombre: 'Ana Ruiz',
  Rol: 'Administrador',
};
const BEA = {
  id_usuario: '000002',
  Email: 'bea@grupo.test',
  Nombre: 'Bea Soler',
  Rol: 'Encargado',
};
const OBRA = 'p-obra';
const HOY = '2026-08-26';

function ctxDe(persona) {
  return crearContextoAcceso({
    idUsuario: persona.id_usuario,
    nombre: persona.Nombre,
    rol: persona.Rol,
    permisos: ['proyectos.ver', 'proyectos.editar', 'tareas.editar_todas', 'tareas.ver_todas'],
  });
}

function montar({ paginaTam = 0 } = {}) {
  const db = crearDynamoMemoria({ paginaTam });
  db.crearTabla(tables.notificaciones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      [IDX_NO_LEIDAS]: {
        hashKey: 'usuario_no_leida',
        rangeKey: 'creado_en',
        proyeccion: 'KEYS_ONLY',
      },
    },
  });
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
    },
  });
  db.crearTabla(tables.proyectos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  invalidarContextoAcceso();

  for (const u of [ANA, BEA]) db.sembrar(tables.usuarios, u);
  db.sembrar(tables.proyectos, {
    PK: PK.proyecto(OBRA),
    SK: SK.meta,
    id_proyecto: OBRA,
    nombre: 'Reforma',
    estado: 'activo',
    responsable_id: ANA.id_usuario,
    gsi_listado: 'PROY',
  });
  for (const id of [ANA.id_usuario, BEA.id_usuario]) {
    db.sembrar(tables.proyectos, {
      PK: PK.proyecto(OBRA),
      SK: SK.miembro(id),
      usuario_id: id,
      rol_proyecto: id === ANA.id_usuario ? 'responsable' : 'miembro',
    });
  }
  return db;
}

function sembrarTarea(db, datos) {
  const tarea = { estado: 'pendiente', prioridad: 'media', ...datos };
  const item = { PK: PK.tarea(tarea.id_tarea), SK: SK.meta, ...tarea };
  const vencimiento = vencimientoOrdenDe(tarea);
  if (vencimiento) item.vencimiento_orden = vencimiento;
  db.sembrar(tables.tareas, item);
  return item;
}

// ─── Helper de notificaciones ───

test('TIPOS_NOTIFICACION admite compra_pendiente y acta_lista sin emisores obligatorios', () => {
  assert.ok(TIPOS_NOTIFICACION.includes('compra_pendiente'));
  assert.ok(TIPOS_NOTIFICACION.includes('acta_lista'));
});

test('crear, contar no leídas por GSI y marcar leídas quita usuario_no_leida', async () => {
  const db = montar();

  const a = await crearNotificacion({
    usuarioId: ANA.id_usuario,
    tipo: 'mencion',
    titulo: 'Te han mencionado',
    entidad_ref: { tipo: 'tarea', id: 't1', etiqueta: 'X' },
  });
  const b = await crearNotificacion({
    usuarioId: ANA.id_usuario,
    tipo: 'asignacion',
    titulo: 'Te han asignado',
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const conteo = await contarNoLeidas({ usuarioId: ANA.id_usuario });
  assert.equal(conteo.total, 2);

  assert.equal(
    db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tables.notificaciones).length,
    0,
    'el contador no hace Scan',
  );

  const lista = await listarNotificaciones({ usuarioId: ANA.id_usuario });
  assert.equal(lista.notificaciones.length, 2);
  assert.equal(lista.notificaciones.every((n) => n.leida === false), true);

  const marcada = await marcarLeidas({
    usuarioId: ANA.id_usuario,
    ids: [a.notificacion.id],
  });
  assert.equal(marcada.marcadas, 1);

  const trasUna = await contarNoLeidas({ usuarioId: ANA.id_usuario });
  assert.equal(trasUna.total, 1);

  const item = db.obtener(tables.notificaciones, {
    PK: PK.usuario(ANA.id_usuario),
    SK: a.notificacion.id,
  });
  assert.equal(item.leida, true);
  assert.equal(item.usuario_no_leida, undefined, 'sale del GSI disperso');

  const todas = await marcarLeidas({ usuarioId: ANA.id_usuario, todas: true });
  assert.equal(todas.marcadas, 1);
  assert.equal((await contarNoLeidas({ usuarioId: ANA.id_usuario })).total, 0);
});

test('vencimiento es idempotente por entidad_ref + día', async () => {
  montar();
  const ref = { tipo: 'tarea', id: 't-vence', etiqueta: 'Pedir pan' };

  const primera = await crearNotificacion({
    usuarioId: ANA.id_usuario,
    tipo: 'vencimiento',
    titulo: 'Vence hoy: Pedir pan',
    entidad_ref: ref,
    diaIdempotencia: HOY,
  });
  const segunda = await crearNotificacion({
    usuarioId: ANA.id_usuario,
    tipo: 'vencimiento',
    titulo: 'Vence hoy: Pedir pan',
    entidad_ref: ref,
    diaIdempotencia: HOY,
  });

  assert.equal(primera.ok, true);
  assert.ok(primera.notificacion);
  assert.equal(segunda.ok, true);
  assert.equal(segunda.omitida, true);
  assert.equal(segunda.notificacion, null);
  assert.equal((await contarNoLeidas({ usuarioId: ANA.id_usuario })).total, 1);
});

// ─── Emisores ───

test('crear y reasignar emiten asignacion al nuevo responsable (no al actor)', async () => {
  montar();
  const ctxAna = ctxDe(ANA);

  const creada = await crearTarea({
    ctx: ctxAna,
    datos: {
      titulo: 'Comprar vajilla',
      responsable_id: BEA.id_usuario,
      proyecto_id: OBRA,
      fecha_limite: '2026-09-01',
    },
  });
  assert.equal(creada.ok, true, creada.error);

  const notifsBea = await listarNotificaciones({ usuarioId: BEA.id_usuario });
  assert.equal(notifsBea.notificaciones.length, 1);
  assert.equal(notifsBea.notificaciones[0].tipo, 'asignacion');

  const notifsAna = await listarNotificaciones({ usuarioId: ANA.id_usuario });
  assert.equal(notifsAna.notificaciones.length, 0, 'quien asigna no se notifica a sí mismo');

  const reasig = await reasignarTarea({
    ctx: ctxAna,
    idTarea: creada.tarea.id_tarea,
    responsableId: ANA.id_usuario,
  });
  assert.equal(reasig.ok, true, reasig.error);
  assert.equal((await listarNotificaciones({ usuarioId: ANA.id_usuario })).notificaciones.length, 0);
});

test('comentario con menciones emite mencion (excepto al autor)', async () => {
  montar();
  const ctxAna = ctxDe(ANA);

  const creada = await crearTarea({
    ctx: ctxAna,
    datos: {
      titulo: 'Revisar carta',
      responsable_id: ANA.id_usuario,
      proyecto_id: OBRA,
    },
  });
  assert.equal(creada.ok, true, creada.error);

  const com = await crearComentario({
    ctx: ctxAna,
    idTarea: creada.tarea.id_tarea,
    texto: 'Ojo @000002 y también yo @000001',
    menciones: [BEA.id_usuario, ANA.id_usuario],
  });
  assert.equal(com.ok, true, com.error);

  const deBea = await listarNotificaciones({ usuarioId: BEA.id_usuario });
  assert.equal(deBea.notificaciones.length, 1);
  assert.equal(deBea.notificaciones[0].tipo, 'mencion');

  const deAna = await listarNotificaciones({ usuarioId: ANA.id_usuario });
  assert.equal(
    deAna.notificaciones.filter((n) => n.tipo === 'mencion').length,
    0,
    'el autor no recibe mención de sí mismo',
  );
});

test('avisos de vencimiento crean notifs idempotentes además del email', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: AVISOS_AJUSTE_PK,
    SK: AVISOS_AJUSTE_SK,
    Enabled: true,
    hora: '08:30',
  });
  sembrarTarea(db, {
    id_tarea: 't-vence',
    titulo: 'Pagar al fontanero',
    responsable_id: ANA.id_usuario,
    fecha_limite: HOY,
  });

  const r = await enviarAvisosVencimiento({
    hoy: HOY,
    enviar: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.enviados, 1);
  assert.ok(r.notificaciones >= 1);

  const notifs = await listarNotificaciones({ usuarioId: ANA.id_usuario });
  assert.equal(notifs.notificaciones.filter((n) => n.tipo === 'vencimiento').length, 1);

  const dup = await crearNotificacion({
    usuarioId: ANA.id_usuario,
    tipo: 'vencimiento',
    titulo: 'Vence hoy: Pagar al fontanero',
    entidad_ref: { tipo: 'tarea', id: 't-vence', etiqueta: 'Pagar al fontanero' },
    diaIdempotencia: HOY,
  });
  assert.equal(dup.omitida, true);
});

test('sin SMTP se crean notifs de campana y no se intenta el correo', async () => {
  const db = montar();
  db.sembrar(tables.ajustes, {
    PK: AVISOS_AJUSTE_PK,
    SK: AVISOS_AJUSTE_SK,
    Enabled: true,
    hora: '08:30',
  });
  sembrarTarea(db, {
    id_tarea: 't-smtp',
    titulo: 'Sin buzón del servidor',
    responsable_id: ANA.id_usuario,
    fecha_limite: HOY,
  });

  const smtpAntes = process.env.SMTP_USER;
  delete process.env.SMTP_USER;
  try {
    // Sin `enviar` y sin SMTP_USER: canal de email cerrado, campana abierta.
    const r = await enviarAvisosVencimiento({ hoy: HOY });
    assert.equal(r.ok, true);
    assert.equal(r.motivo, 'sin_smtp');
    assert.equal(r.enviados, 0);
    assert.ok(r.notificaciones >= 1);
  } finally {
    if (smtpAntes !== undefined) process.env.SMTP_USER = smtpAntes;
    else delete process.env.SMTP_USER;
  }

  const notifs = await listarNotificaciones({ usuarioId: ANA.id_usuario });
  assert.equal(notifs.notificaciones.filter((n) => n.tipo === 'vencimiento').length, 1);
});

test('listarNotificaciones no salta ítems al paginar', async () => {
  // paginaTam=2 en el doble: cada Query devuelve como máximo 2 filas.
  // limite=2 en listar: si el cursor usara LastEvaluatedKey a pelo tras llenar
  // la página a mitad de una Query, se saltarían ítems.
  montar({ paginaTam: 2 });
  for (let i = 0; i < 5; i += 1) {
    const r = await crearNotificacion({
      usuarioId: ANA.id_usuario,
      tipo: 'mencion',
      titulo: `Aviso ${i}`,
    });
    assert.equal(r.ok, true);
    // Distintos instantes en SK: crearNotificacion usa now(); en el mismo ms
    // el uuid ya diferencia. Forzamos un micro-delay no hace falta.
  }

  const pagina1 = await listarNotificaciones({ usuarioId: ANA.id_usuario, limite: 2 });
  assert.equal(pagina1.notificaciones.length, 2);
  assert.ok(pagina1.cursor, 'hay más páginas');

  const pagina2 = await listarNotificaciones({
    usuarioId: ANA.id_usuario,
    limite: 2,
    cursor: pagina1.cursor,
  });
  assert.equal(pagina2.notificaciones.length, 2);

  const pagina3 = await listarNotificaciones({
    usuarioId: ANA.id_usuario,
    limite: 2,
    cursor: pagina2.cursor,
  });
  assert.equal(pagina3.notificaciones.length, 1);
  assert.equal(pagina3.cursor, null);

  const ids = [
    ...pagina1.notificaciones,
    ...pagina2.notificaciones,
    ...pagina3.notificaciones,
  ].map((n) => n.id);
  assert.equal(new Set(ids).size, 5, 'las tres páginas cubren las cinco sin duplicar ni saltar');
});

// ─── ICS ───

test('ICS solo lleva SUMMARY y DTSTART; sin DESCRIPTION', () => {
  const ics = construirIcs({
    tareas: [{ id_tarea: 't1', titulo: 'Cerrar cocina; urgente', fecha_limite: '2026-09-01' }],
    generadoEn: new Date('2026-08-26T10:00:00Z'),
  });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:Cerrar cocina\\; urgente/);
  assert.match(ics, /DTSTART;VALUE=DATE:20260901/);
  assert.equal(/DESCRIPTION/i.test(ics), false);
});

test('rotar token guarda solo hash y revoca el anterior', async () => {
  montar();
  const primero = await rotarTokenIcs({ usuarioId: ANA.id_usuario });
  assert.equal(primero.ok, true);
  assert.ok(primero.token.startsWith(`${ANA.id_usuario}.`));
  assert.equal((await validarTokenIcs(primero.token)).ok, true);

  const rGet = await docClient.send(
    new GetCommand({
      TableName: tables.ajustes,
      Key: { PK: ICS_AJUSTE_PK, SK: `${ICS_TOKEN_SK_PREFIJO}${ANA.id_usuario}` },
    }),
  );
  assert.ok(rGet.Item?.token_hash);
  assert.equal(rGet.Item.token_hash, hashTokenIcs(primero.token));
  assert.equal(rGet.Item.token, undefined, 'nunca el token en claro');

  const segundo = await rotarTokenIcs({ usuarioId: ANA.id_usuario });
  assert.equal((await validarTokenIcs(primero.token)).ok, false, 'el anterior queda revocado');
  assert.equal((await validarTokenIcs(segundo.token)).ok, true);
});

test('feed ICS lista vencimientos del dueño del token sin DESCRIPTION', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 'abierta',
    titulo: 'Revisar stock',
    responsable_id: ANA.id_usuario,
    fecha_limite: '2026-09-10',
    descripcion: 'SECRETO: cláusula de despido',
  });
  sembrarTarea(db, {
    id_tarea: 'sin-fecha',
    titulo: 'Sin plazo',
    responsable_id: ANA.id_usuario,
  });
  sembrarTarea(db, {
    id_tarea: 'de-bea',
    titulo: 'Tarea de Bea',
    responsable_id: BEA.id_usuario,
    fecha_limite: '2026-09-05',
  });

  const { token } = await rotarTokenIcs({ usuarioId: ANA.id_usuario });
  const feed = await feedVencimientosIcs(token);
  assert.equal(feed.ok, true);
  assert.match(feed.ics, /SUMMARY:Revisar stock/);
  assert.equal(feed.ics.includes('SECRETO'), false);
  assert.equal(feed.ics.includes('Tarea de Bea'), false);
  assert.equal(feed.ics.includes('Sin plazo'), false);
  assert.equal(/DESCRIPTION/i.test(feed.ics), false);

  const tareas = await tareasAbiertasConVencimiento(ANA.id_usuario);
  assert.equal(tareas.length, 1);
  assert.equal(tareas[0].id_tarea, 'abierta');
});

// ─── Directory stub ───

test('Directory stub: no disponible y sincronizar no toca usuarios', async () => {
  const db = montar();
  assert.equal(directory.disponible(), false);
  assert.deepEqual([...directory.CAMPOS_DIRECTORY_PERMITIDOS], ['google_directory_id']);
  const r = await directory.sincronizar();
  assert.equal(r.ok, false);
  assert.equal(r.sincronizados, 0);
  assert.equal(db.listar(tables.usuarios).length, 2, 'no modifica usuarios');
});

// ─── Identidad del JWT en la ruta ───

test('la ruta de notificaciones toma el id de sub del JWT, no de id_usuario', async () => {
  // El login firma { sub, email, rol }. Si la ruta mirara id_usuario, devolvería
  // 401 a un Bearer válido y la campana expulsaría la sesión.
  const { idUsuarioDeToken } = await import('../routes/notificaciones.js');
  assert.equal(idUsuarioDeToken({ sub: '000003', email: 'a@b.com', rol: 'Local' }), '000003');
  assert.equal(idUsuarioDeToken({ id_usuario: '000003' }), '', 'sin sub no hay id');
  assert.equal(idUsuarioDeToken(null), '');
});
