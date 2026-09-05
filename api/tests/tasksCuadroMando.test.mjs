/**
 * Cuadro de mando de dirección (Fase 4).
 *
 * - 403 sin `proyectos.cuadro_mando` (no basta `proyectos.ver`)
 * - Agregados de proyectos / carga / incumplidos
 * - Lo no visible no sale
 * - Sin Scan
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-cuadro-mando';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK, GSI_LISTADO, skProyectoDe } = await import('../lib/tasks/tipos.js');
const { MAX_REUNIONES_INCUMPLIDOS } = await import('../lib/tasks/cuadroMando.js');
const { default: proyectosRouter } = await import('../routes/proyectos.js');

const JEFE = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador', Nombre: 'Jefe' };
const DIRECTOR = {
  sub: '000020',
  email: 'dir@grupo.test',
  rol: 'Direccion',
  Nombre: 'Diana',
  Apellidos: 'Director',
};
/** Ve proyectos pero no el cuadro de mando. */
const CARLOS = { sub: '000009', email: 'carlos@grupo.test', rol: 'Camarero', Nombre: 'Carlos' };
const ANA = {
  sub: '000007',
  email: 'ana@grupo.test',
  rol: 'Jefa de proyectos',
  Nombre: 'Ana',
  Apellidos: 'Ruiz',
};

const PERMISOS_POR_ROL = {
  Direccion: [
    'proyectos.ver',
    'proyectos.crear',
    'proyectos.cuadro_mando',
    'reuniones.ver',
    'reuniones.ver_direccion',
    'tareas.ver_todas',
  ],
  'Jefa de proyectos': ['proyectos.ver', 'proyectos.crear', 'proyectos.editar'],
  Camarero: ['proyectos.ver', 'reuniones.ver'],
};

let usuarioActual = DIRECTOR;
let servidor = null;
let base = '';

async function api(metodo, ruta, cuerpo, usuario = DIRECTOR) {
  usuarioActual = usuario;
  if (!servidor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = usuarioActual;
      next();
    });
    app.use('/api', proyectosRouter);
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
  db.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'actualizado_en' },
      'Miembro-index': { hashKey: 'usuario_id', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' },
    },
  });
  db.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' },
      'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' },
    },
  });
  db.crearTabla(tables.reuniones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'fecha' },
      'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'fecha' },
      'Serie-index': { hashKey: 'serie_id', rangeKey: 'fecha' },
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

  for (const u of [JEFE, DIRECTOR, CARLOS, ANA]) {
    db.sembrar(tables.usuarios, {
      id_usuario: u.sub,
      Email: u.email,
      Rol: u.rol,
      Nombre: u.Nombre || u.email.split('@')[0],
      Apellidos: u.Apellidos || '',
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
  db.sembrar(tables.ajustes, {
    PK: 'departamentos',
    SK: 'DEP#dep-ops',
    nombre: 'Operaciones',
    responsable_id: DIRECTOR.sub,
    activo: true,
    orden: 2,
  });

  db.instalar(docClient);
  invalidarContextoAcceso();
  return db;
}

function sembrarProyecto(db, { id, nombre, estado = 'activo', responsable = DIRECTOR.sub, departamento = 'dep-mkt', actualizado = '2026-09-01T10:00:00.000Z', miembros = [] }) {
  db.sembrar(tables.proyectos, {
    PK: PK.proyecto(id),
    SK: SK.meta,
    id_proyecto: id,
    nombre,
    estado,
    responsable_id: responsable,
    departamento_id: departamento,
    creado_por: responsable,
    creado_en: actualizado,
    actualizado_en: actualizado,
    gsi_listado: GSI_LISTADO.proyecto,
  });
  const equipo = miembros.length
    ? miembros
    : [{ usuario_id: responsable, rol_proyecto: 'responsable' }];
  for (const m of equipo) {
    db.sembrar(tables.proyectos, {
      PK: PK.proyecto(id),
      SK: SK.miembro(m.usuario_id),
      usuario_id: m.usuario_id,
      rol_proyecto: m.rol_proyecto || 'miembro',
      anadido_en: actualizado,
    });
  }
}

function sembrarTarea(db, { id, proyecto, titulo, estado = 'pendiente', responsable, departamento = 'dep-mkt', fecha_limite = '' }) {
  const tarea = {
    id_tarea: id,
    titulo,
    estado,
    proyecto_id: proyecto,
    responsable_id: responsable,
    departamento_id: departamento,
    fecha_limite: fecha_limite || undefined,
  };
  const sk = skProyectoDe(tarea);
  db.sembrar(tables.tareas, {
    PK: PK.tarea(id),
    SK: SK.meta,
    ...tarea,
    ...(sk && { sk_proyecto: sk }),
    creado_en: '2026-08-01T10:00:00.000Z',
    actualizado_en: '2026-08-01T10:00:00.000Z',
  });
}

function sembrarReunion(db, { id, titulo, fecha, visibilidad = 'empresa', departamento = '', acuerdos = [], asistentes = [] }) {
  db.sembrar(tables.reuniones, {
    PK: PK.reunion(id),
    SK: SK.meta,
    id_reunion: id,
    titulo,
    fecha,
    estado: 'acta_validada',
    visibilidad,
    ...(departamento && { departamento_id: departamento }),
    convocada_por: DIRECTOR.sub,
    gsi_listado: GSI_LISTADO.reunion,
    creado_en: `${fecha}T08:00:00.000Z`,
    actualizado_en: `${fecha}T08:00:00.000Z`,
  });
  for (const uid of asistentes) {
    db.sembrar(tables.reuniones, {
      PK: PK.reunion(id),
      SK: SK.asistente(uid),
      usuario_id: uid,
      nombre: '',
      asistio: true,
      es_externo: false,
    });
  }
  for (const ac of acuerdos) {
    db.sembrar(tables.reuniones, {
      PK: PK.reunion(id),
      SK: SK.acuerdo(ac.id_acuerdo),
      id_acuerdo: ac.id_acuerdo,
      texto: ac.texto,
      responsable_id: ac.responsable_id || '',
      fecha_limite: ac.fecha_limite || '',
      estado: ac.estado || 'abierto',
      tarea_id: ac.tarea_id || '',
    });
  }
}

function operacionesScan(db) {
  return db.operaciones.filter((o) => o.tipo === 'ScanCommand');
}

// ─── Permiso ───

test('sin proyectos.cuadro_mando responde 403 aunque tenga proyectos.ver', async () => {
  montar();
  const r = await api('GET', '/api/proyectos/cuadro-mando', undefined, CARLOS);
  assert.equal(r.status, 403);
  assert.match(String(r.body.error || ''), /permiso/i);
});

// ─── Agregados ───

test('agrega proyectos, carga e incumplidos visibles', async () => {
  const db = montar();
  const antes = db.operaciones.length;

  sembrarProyecto(db, { id: 'p-activo', nombre: 'Apertura', estado: 'activo', responsable: ANA.sub });
  sembrarProyecto(db, { id: 'p-pausa', nombre: 'Pausa', estado: 'en_pausa', responsable: DIRECTOR.sub, departamento: 'dep-ops' });
  sembrarProyecto(db, { id: 'p-cerrado', nombre: 'Cerrado', estado: 'cerrado', responsable: DIRECTOR.sub });

  // Abierta vencida + bloqueada + hecha (no cuenta en carga)
  sembrarTarea(db, {
    id: 't1',
    proyecto: 'p-activo',
    titulo: 'Vencida',
    estado: 'pendiente',
    responsable: ANA.sub,
    departamento: 'dep-mkt',
    fecha_limite: '2020-01-01',
  });
  sembrarTarea(db, {
    id: 't2',
    proyecto: 'p-activo',
    titulo: 'Bloqueada',
    estado: 'bloqueada',
    responsable: ANA.sub,
    departamento: 'dep-mkt',
    fecha_limite: '2099-01-01',
  });
  sembrarTarea(db, {
    id: 't3',
    proyecto: 'p-activo',
    titulo: 'Hecha',
    estado: 'hecha',
    responsable: ANA.sub,
    departamento: 'dep-mkt',
  });
  // Proyecto cerrado: no alimenta carga aunque tuviera abierta rara
  sembrarTarea(db, {
    id: 't4',
    proyecto: 'p-cerrado',
    titulo: 'Huérfana abierta',
    estado: 'pendiente',
    responsable: DIRECTOR.sub,
    departamento: 'dep-ops',
    fecha_limite: '2020-06-01',
  });

  sembrarReunion(db, {
    id: 'r1',
    titulo: 'Comité',
    fecha: '2026-08-20',
    visibilidad: 'empresa',
    acuerdos: [
      {
        id_acuerdo: 'a1',
        texto: 'Firmar contrato',
        estado: 'incumplido',
        responsable_id: ANA.sub,
        fecha_limite: '2026-07-01',
        tarea_id: 't1',
      },
      {
        id_acuerdo: 'a2',
        texto: 'Cumplido',
        estado: 'cumplido',
        responsable_id: ANA.sub,
      },
    ],
  });

  const r = await api('GET', '/api/proyectos/cuadro-mando', undefined, DIRECTOR);
  assert.equal(r.status, 200);
  assert.ok(r.body.generado_en);
  assert.equal(r.body.proyectos.por_estado.activo, 1);
  assert.equal(r.body.proyectos.por_estado.en_pausa, 1);
  assert.equal(r.body.proyectos.por_estado.cerrado, 1);
  assert.equal(r.body.proyectos.activos.length, 1);
  assert.equal(r.body.proyectos.activos[0].id_proyecto, 'p-activo');
  assert.equal(r.body.proyectos.activos[0].responsable_nombre, 'Ana Ruiz');

  assert.equal(r.body.acuerdos_incumplidos.length, 1);
  assert.equal(r.body.acuerdos_incumplidos[0].id_acuerdo, 'a1');
  assert.equal(r.body.acuerdos_incumplidos[0].reunion_titulo, 'Comité');
  assert.equal(r.body.acuerdos_incumplidos[0].responsable_nombre, 'Ana Ruiz');
  assert.equal(r.body.acuerdos_incumplidos[0].tarea_id, 't1');
  assert.equal(r.body.acuerdos_incumplidos_truncado, undefined);

  const ana = r.body.carga_personas.find((p) => p.usuario_id === ANA.sub);
  assert.ok(ana);
  assert.equal(ana.abiertas, 2);
  assert.equal(ana.vencidas, 1);
  assert.equal(ana.bloqueadas, 1);
  assert.equal(ana.nombre, 'Ana Ruiz');

  // t4 del cerrado no entra
  const dir = r.body.carga_personas.find((p) => p.usuario_id === DIRECTOR.sub);
  assert.equal(dir, undefined);

  const mkt = r.body.carga_departamentos.find((d) => d.departamento_id === 'dep-mkt');
  assert.ok(mkt);
  assert.equal(mkt.nombre, 'Marketing');
  assert.equal(mkt.abiertas, 2);

  const scans = db.operaciones.slice(antes).filter((o) => o.tipo === 'ScanCommand');
  assert.equal(scans.length, 0, 'el cuadro de mando no puede hacer Scan');
});

test('reuniones y proyectos no visibles no salen en el agregado', async () => {
  const db = montar();

  // Proyecto solo de Ana: Carlos (sin cuadro) no aplica; Director con tareas.ver_todas sí lo ve.
  // Para el caso «no visible» usamos reunión de dirección sin permiso extra y proyecto
  // que solo ve Ana: montamos un usuario con cuadro_mando pero SIN tareas.ver_todas.
  db.sembrar(tables.usuarios, {
    id_usuario: '000030',
    Email: 'limit@grupo.test',
    Rol: 'Cuadro limitado',
    Nombre: 'Luis',
  });
  for (const codigo of ['proyectos.ver', 'proyectos.cuadro_mando', 'reuniones.ver']) {
    db.sembrar(tables.rolesPermisos, { PK: 'ROL#Cuadro limitado', SK: `PERMISO#${codigo}` });
  }
  const LIMITADO = { sub: '000030', email: 'limit@grupo.test', rol: 'Cuadro limitado' };

  sembrarProyecto(db, {
    id: 'p-ana',
    nombre: 'Solo Ana',
    estado: 'activo',
    responsable: ANA.sub,
    miembros: [{ usuario_id: ANA.sub, rol_proyecto: 'responsable' }],
  });
  sembrarProyecto(db, {
    id: 'p-luis',
    nombre: 'De Luis',
    estado: 'activo',
    responsable: LIMITADO.sub,
    miembros: [{ usuario_id: LIMITADO.sub, rol_proyecto: 'responsable' }],
  });
  sembrarTarea(db, {
    id: 't-secreta',
    proyecto: 'p-ana',
    titulo: 'Secreta',
    responsable: ANA.sub,
    fecha_limite: '2020-01-01',
  });
  sembrarTarea(db, {
    id: 't-luis',
    proyecto: 'p-luis',
    titulo: 'Visible',
    responsable: LIMITADO.sub,
    departamento: 'dep-ops',
  });

  sembrarReunion(db, {
    id: 'r-dir',
    titulo: 'Dirección',
    fecha: '2026-08-25',
    visibilidad: 'direccion',
    acuerdos: [
      { id_acuerdo: 'ax', texto: 'Secreto', estado: 'incumplido', responsable_id: ANA.sub },
    ],
  });
  sembrarReunion(db, {
    id: 'r-emp',
    titulo: 'Empresa',
    fecha: '2026-08-24',
    visibilidad: 'empresa',
    acuerdos: [
      { id_acuerdo: 'ay', texto: 'Público', estado: 'incumplido', responsable_id: LIMITADO.sub },
    ],
  });

  const r = await api('GET', '/api/proyectos/cuadro-mando', undefined, LIMITADO);
  assert.equal(r.status, 200);
  assert.equal(r.body.proyectos.por_estado.activo, 1);
  assert.equal(r.body.proyectos.activos[0].id_proyecto, 'p-luis');
  assert.ok(!r.body.carga_personas.some((p) => p.usuario_id === ANA.sub));
  assert.equal(r.body.acuerdos_incumplidos.length, 1);
  assert.equal(r.body.acuerdos_incumplidos[0].id_acuerdo, 'ay');
  assert.ok(!r.body.acuerdos_incumplidos.some((a) => a.id_acuerdo === 'ax'));
});

test('constante de tope de reuniones documentada', () => {
  assert.equal(MAX_REUNIONES_INCUMPLIDOS, 100);
});
