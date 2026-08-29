/**
 * Reuniones del módulo de dirección (Fase 1B).
 *
 * Fija las reglas que no deben romperse:
 *
 * - Visibilidad al listar y al pedir por id (`404`, no `403`).
 * - Orden del día bloqueado al pasar a `celebrada` (D-20).
 * - Acuerdos → tareas en un solo camino de servidor (D-23).
 * - Aviso de grabación persistido.
 * - Calendar stub no tumba la reunión (D-21).
 * - Sin `Scan`: solo Query a índices registrados.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-reuniones';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { default: reunionesRouter } = await import('../routes/reuniones.js');

const JEFE = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const ANA = { sub: '000007', email: 'ana@grupo.test', rol: 'Gestora reuniones' };
const BEA = { sub: '000008', email: 'bea@grupo.test', rol: 'Solo ver' };
const CARLOS = { sub: '000009', email: 'carlos@grupo.test', rol: 'Camarero' };

const PERMISOS_POR_ROL = {
  'Gestora reuniones': [
    'reuniones.ver',
    'reuniones.gestionar',
    'reuniones.ver_direccion',
    'proyectos.editar',
  ],
  'Solo ver': ['reuniones.ver'],
  Camarero: ['reuniones.ver'],
};

let usuarioActual = ANA;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = ANA) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', reunionesRouter);
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

function montar() {
  const db = crearDynamoMemoria();
  db.crearTabla(tables.reuniones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'fecha' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'fecha' },
      'Serie-index': { hashKey: 'serie_id', rangeKey: 'fecha' },
    },
  });
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Reunion-index': { hashKey: 'reunion_origen_id', rangeKey: 'creado_en' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
      'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' },
    },
  });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.notificaciones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'NoLeidas-index': { hashKey: 'usuario_no_leida', rangeKey: 'creado_en', proyeccion: 'KEYS_ONLY' },
    },
  });
  db.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'actualizado_en' },
      'Miembro-index': { hashKey: 'usuario_id', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' },
    },
  });

  for (const u of [JEFE, ANA, BEA, CARLOS]) {
    db.sembrar(tables.usuarios, {
      id_usuario: u.sub,
      Email: u.email,
      Rol: u.rol,
      Nombre: u.email.split('@')[0],
      Locales: u.sub === CARLOS.sub ? ['Bar Central'] : [],
      Departamentos: u.sub === BEA.sub ? ['dep-mkt'] : u.sub === ANA.sub ? ['dep-mkt'] : [],
    });
  }
  for (const [rol, codigos] of Object.entries(PERMISOS_POR_ROL)) {
    for (const codigo of codigos) {
      db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${codigo}` });
    }
  }
  db.sembrar(tables.ajustes, {
    PK: 'departamentos',
    SK: 'DEP#dep-mkt',
    nombre: 'Marketing',
    responsable_id: ANA.sub,
    activo: true,
    orden: 1,
  });

  db.instalar(docClient);
  invalidarContextoAcceso();
  return db;
}

function sembrarReunion(
  db,
  {
    id,
    titulo = 'Comité',
    fecha = '2026-08-20',
    estado = 'convocada',
    visibilidad = 'departamento',
    departamento = 'dep-mkt',
    localNombre = '',
    serie = '',
    proyecto = '',
    convocadaPor = ANA.sub,
    orden = '1. Presupuesto\n2. Contrataciones',
    asistentes = [],
    acuerdos = [],
    puntos = [],
  },
) {
  db.sembrar(tables.reuniones, {
    PK: `REU#${id}`,
    SK: 'META',
    id_reunion: id,
    titulo,
    fecha,
    hora_inicio: '10:00',
    hora_fin: '11:00',
    estado,
    visibilidad,
    ...(departamento && { departamento_id: departamento }),
    ...(localNombre && { local_nombre: localNombre }),
    ...(serie && { serie_id: serie }),
    ...(proyecto && { proyecto_id: proyecto }),
    orden_del_dia: orden,
    convocada_por: convocadaPor,
    gsi_listado: 'REU',
    creado_en: `${fecha}T08:00:00.000Z`,
    actualizado_en: `${fecha}T08:00:00.000Z`,
  });
  for (const a of asistentes) {
    const uid = a.usuario_id || a;
    db.sembrar(tables.reuniones, {
      PK: `REU#${id}`,
      SK: `ASIST#${uid}`,
      usuario_id: uid,
      nombre: a.nombre || '',
      asistio: true,
      es_externo: false,
    });
  }
  for (const ac of acuerdos) {
    db.sembrar(tables.reuniones, {
      PK: `REU#${id}`,
      SK: `ACUERDO#${ac.id_acuerdo}`,
      id_acuerdo: ac.id_acuerdo,
      texto: ac.texto,
      responsable_id: ac.responsable_id || '',
      fecha_limite: ac.fecha_limite || '',
      estado: ac.estado || 'abierto',
      tarea_id: ac.tarea_id || '',
    });
  }
  for (const p of puntos) {
    db.sembrar(tables.reuniones, {
      PK: `REU#${id}`,
      SK: `PUNTO#${String(p.orden ?? 1).padStart(3, '0')}`,
      texto_punto: p.texto_punto,
      aplazado: !!p.aplazado,
      candidato_siguiente: !!p.candidato_siguiente,
    });
  }
  return id;
}

function operacionesScan(db) {
  return db.operaciones.filter((o) => o.tipo === 'ScanCommand');
}

// ─── Visibilidad ───

test('quien no alcanza la reunión no la ve ni listando ni por id (404)', async () => {
  const db = montar();
  sembrarReunion(db, { id: 'r1', visibilidad: 'direccion', departamento: '' });

  const lista = await api('GET', '/api/reuniones', undefined, CARLOS);
  assert.equal(lista.status, 200);
  assert.deepEqual(lista.body.reuniones, []);

  const ficha = await api('GET', '/api/reuniones/r1', undefined, CARLOS);
  assert.equal(ficha.status, 404);
  assert.ok(ficha.body.error);

  // Ana tiene ver_direccion → sí la ve.
  const suya = await api('GET', '/api/reuniones/r1', undefined, ANA);
  assert.equal(suya.status, 200);
  assert.equal(suya.body.reunion.titulo, 'Comité');
  assert.ok(suya.body.reunion.permisos_fila);
  assert.equal(suya.body.reunion.permisos_fila.editar, true);
});

test('un asistente ve la reunión restringida aunque no esté autorizado', async () => {
  const db = montar();
  sembrarReunion(db, {
    id: 'r2',
    visibilidad: 'restringida',
    departamento: '',
    convocadaPor: ANA.sub,
    asistentes: [BEA.sub],
  });
  // Bea solo tiene reuniones.ver; restringida no se abre por permiso.
  const ficha = await api('GET', '/api/reuniones/r2', undefined, BEA);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.reunion.visibilidad, 'restringida');
  assert.equal(ficha.body.reunion.permisos_fila.editar, false);

  const lista = await api('GET', '/api/reuniones', undefined, BEA);
  assert.equal(lista.status, 200);
  assert.equal(lista.body.reuniones.length, 1);
});

test('listado y detalle no usan Scan', async () => {
  const db = montar();
  sembrarReunion(db, { id: 'r3' });
  db.operaciones.length = 0;

  await api('GET', '/api/reuniones');
  await api('GET', '/api/reuniones/r3');
  assert.equal(operacionesScan(db).length, 0, 'ni listado ni ficha pueden hacer Scan');
});

// ─── Orden del día (D-20) ───

test('al pasar a celebrada se congela el orden; un PATCH posterior responde 409', async () => {
  const db = montar();
  sembrarReunion(db, { id: 'r4', estado: 'convocada', orden: 'Punto A' });

  const celeb = await api('PATCH', '/api/reuniones/r4', { estado: 'celebrada' });
  assert.equal(celeb.status, 200, JSON.stringify(celeb.body));
  assert.equal(celeb.body.reunion.estado, 'celebrada');
  assert.equal(celeb.body.reunion.orden_del_dia_congelado, 'Punto A');
  assert.ok(celeb.body.reunion.orden_del_dia_congelado_en);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r4', SK: 'META' });
  assert.equal(meta.orden_del_dia_congelado, 'Punto A');

  const patchOrden = await api('PATCH', '/api/reuniones/r4', { orden_del_dia: 'Otro texto' });
  assert.equal(patchOrden.status, 409);
  assert.ok(patchOrden.body.error.includes('orden'));
});

test('en borrador o convocada el orden del día sí se edita', async () => {
  const db = montar();
  sembrarReunion(db, { id: 'r5', estado: 'convocada', orden: 'Viejo' });

  const ok = await api('PATCH', '/api/reuniones/r5', { orden_del_dia: 'Nuevo orden' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.reunion.orden_del_dia, 'Nuevo orden');
  assert.equal(ok.body.reunion.orden_del_dia_congelado, undefined);
});

// ─── Calendar stub (D-21) ───

test('crear reunión sin Google deja calendario_sincronizado false y no tumba', async () => {
  const db = montar();
  const creada = await api('POST', '/api/reuniones', {
    titulo: 'Kickoff',
    fecha: '2026-09-01',
    hora_inicio: '09:00',
    hora_fin: '10:00',
    visibilidad: 'empresa',
    orden_del_dia: 'Agenda',
  });
  assert.equal(creada.status, 200, JSON.stringify(creada.body));
  assert.equal(creada.body.calendario_sincronizado, false);
  assert.ok(creada.body.reunion?.id_reunion);
  assert.ok(!creada.body.reunion.calendar_event_id);
  assert.equal(creada.body.calendar_disponible, false);

  const meta = db.obtener(tables.reuniones, {
    PK: `REU#${creada.body.reunion.id_reunion}`,
    SK: 'META',
  });
  assert.equal(meta.gsi_listado, 'REU');
  assert.equal(meta.titulo, 'Kickoff');
});

// ─── Aviso de grabación ───

test('aviso de grabación registra informados y aceptación', async () => {
  const db = montar();
  sembrarReunion(db, { id: 'r6' });

  const r = await api('POST', '/api/reuniones/r6/aviso-grabacion', {
    informados: [ANA.sub, BEA.sub],
    aceptado: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.aviso_grabacion.informados, [ANA.sub, BEA.sub]);
  assert.equal(r.body.aviso_grabacion.aceptado_por, ANA.sub);
  assert.ok(r.body.aviso_grabacion.aceptado_en);

  const meta = db.obtener(tables.reuniones, { PK: 'REU#r6', SK: 'META' });
  assert.equal(meta.aviso_grabacion.aceptado_por, ANA.sub);
});

// ─── Acuerdos → tareas (D-23) ───

test('crear-tareas desde acuerdos enlaza tarea_id en un solo paso', async () => {
  const db = montar();
  sembrarReunion(db, {
    id: 'r7',
    acuerdos: [
      {
        id_acuerdo: 'a1',
        texto: 'Contratar técnico de sala',
        responsable_id: BEA.sub,
        fecha_limite: '2026-09-15',
        estado: 'abierto',
      },
      {
        id_acuerdo: 'a2',
        texto: 'Ya convertido',
        responsable_id: BEA.sub,
        estado: 'abierto',
        tarea_id: 'ya-existe',
      },
    ],
  });

  const r = await api('POST', '/api/reuniones/r7/acuerdos/crear-tareas', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.creadas.length, 1);
  assert.equal(r.body.enlazados.length, 1);
  assert.equal(r.body.enlazados[0].id_acuerdo, 'a1');
  assert.ok(r.body.enlazados[0].tarea_id);

  const acuerdo = db.obtener(tables.reuniones, { PK: 'REU#r7', SK: 'ACUERDO#a1' });
  assert.equal(acuerdo.tarea_id, r.body.enlazados[0].tarea_id);

  const tarea = db.obtener(tables.tareas, {
    PK: `TAREA#${r.body.enlazados[0].tarea_id}`,
    SK: 'META',
  });
  assert.equal(tarea.reunion_origen_id, 'r7');
  assert.equal(tarea.responsable_id, BEA.sub);

  const listado = await api('GET', '/api/reuniones/r7/tareas');
  assert.equal(listado.status, 200);
  assert.equal(listado.body.tareas.length, 1);
  assert.equal(operacionesScan(db).length, 0);
});

// ─── Sugerencia orden del día ───

test('sugerencia de orden del día trae acuerdos abiertos de la reunión anterior de la serie', async () => {
  const db = montar();
  sembrarReunion(db, {
    id: 'r-prev',
    fecha: '2026-07-01',
    serie: 'serie-comite',
    acuerdos: [
      { id_acuerdo: 'ap1', texto: 'Cerrar presupuesto Q3', responsable_id: ANA.sub, estado: 'abierto' },
    ],
    puntos: [{ orden: 1, texto_punto: 'Reformas terraza', aplazado: true }],
  });
  sembrarReunion(db, {
    id: 'r-nueva',
    fecha: '2026-08-01',
    serie: 'serie-comite',
    orden: '',
  });

  const r = await api('GET', '/api/reuniones/r-nueva/sugerencia-orden-del-dia');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.origen_reunion_id, 'r-prev');
  assert.ok(r.body.texto.includes('Cerrar presupuesto Q3'));
  assert.ok(r.body.texto.includes('Reformas terraza'));

  // No auto-aplica: la reunión nueva sigue sin orden.
  const meta = db.obtener(tables.reuniones, { PK: 'REU#r-nueva', SK: 'META' });
  assert.equal(meta.orden_del_dia, '');
});

// ─── Local + permisos_fila ───

test('reunión de local exige local_nombre y filtra por nombre de Locales', async () => {
  const db = montar();
  const creada = await api('POST', '/api/reuniones', {
    titulo: 'Briefing local',
    fecha: '2026-08-15',
    visibilidad: 'local',
    local_nombre: 'Bar Central',
  });
  assert.equal(creada.status, 200, JSON.stringify(creada.body));
  assert.equal(creada.body.reunion.local_nombre, 'Bar Central');

  // Carlos tiene el local → la ve; Bea (Locales vacío = alcance global) también
  // con reuniones.ver. Quien no tiene el permiso de módulo no entra: ya cubierto.
  const deCarlos = await api(
    'GET',
    `/api/reuniones/${creada.body.reunion.id_reunion}`,
    undefined,
    CARLOS,
  );
  assert.equal(deCarlos.status, 200);
  assert.equal(deCarlos.body.reunion.permisos_fila.editar, false);
});

test('DELETE borra la partición entera', async () => {
  const db = montar();
  sembrarReunion(db, {
    id: 'r-del',
    asistentes: [BEA.sub],
    acuerdos: [{ id_acuerdo: 'ax', texto: 'X', responsable_id: ANA.sub }],
  });

  const r = await api('DELETE', '/api/reuniones/r-del');
  assert.equal(r.status, 200);
  assert.equal(r.body.calendario_sincronizado, true);

  const filas = db.listar(tables.reuniones).filter((it) => it.PK === 'REU#r-del');
  assert.equal(filas.length, 0);

  const ficha = await api('GET', '/api/reuniones/r-del');
  assert.equal(ficha.status, 404);
});
