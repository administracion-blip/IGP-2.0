/**
 * Fase 2F — cola de validación de propuestas.
 *
 * - Listar pendientes vía `Propuesta-Estado-index` (sin Scan); rellena N visibles.
 * - GSI disperso: al resolver se REMOVE `propuesta_estado` y queda `estado`.
 * - Aceptar → tarea con `propuesta_origen_id` (idempotente vía lote).
 * - Acuerdos idempotentes (sin segundo ACUERDO#).
 * - Rechazar → marca estado, no borra.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-propuestas';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { default: reunionesRouter } = await import('../routes/reuniones.js');
const { PK, SK } = await import('../lib/tasks/tipos.js');

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
      'Propuesta-Estado-index': { hashKey: 'propuesta_estado', rangeKey: 'creado_en' },
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
      Departamentos: u.sub === BEA.sub || u.sub === ANA.sub ? ['dep-mkt'] : [],
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

function operacionesScan(db) {
  return db.operaciones.filter((o) => o.tipo === 'ScanCommand');
}

function sembrarReunionConPropuestas(
  db,
  { id, visibilidad = 'departamento', convocadaPor = ANA.sub, propuestas = [] },
) {
  const fecha = '2026-08-20';
  db.sembrar(tables.reuniones, {
    PK: PK.reunion(id),
    SK: SK.meta,
    id_reunion: id,
    titulo: `Comité ${id}`,
    fecha,
    hora_inicio: '10:00',
    hora_fin: '11:00',
    estado: 'acta_borrador',
    visibilidad,
    departamento_id: 'dep-mkt',
    convocada_por: convocadaPor,
    gsi_listado: 'REU',
    creado_en: `${fecha}T08:00:00.000Z`,
    actualizado_en: `${fecha}T08:00:00.000Z`,
  });

  for (const [i, p] of propuestas.entries()) {
    const idProp = p.id_propuesta || `prop-${id}-${i}`;
    const creado = p.creado_en || `2026-08-20T10:${String(i).padStart(2, '0')}:00.000Z`;
    const pendiente = p.pendiente !== false && !p.estado;
    const item = {
      PK: PK.reunion(id),
      SK: SK.propuesta(idProp),
      id_propuesta: idProp,
      tipo: p.tipo || 'tarea',
      titulo: p.titulo || `Propuesta ${idProp}`,
      descripcion: p.descripcion || p.titulo || `Desc ${idProp}`,
      cita: p.cita === undefined ? `«cita literal ${idProp}»` : p.cita,
      responsable_sugerido_id: p.responsable_sugerido_id ?? ANA.sub,
      fecha_limite_sugerida: p.fecha_limite_sugerida || '2026-09-01',
      creado_en: creado,
      ...(pendiente ? { propuesta_estado: 'pendiente' } : {}),
      ...(p.estado ? { estado: p.estado } : {}),
      ...(p.tarea_id && { tarea_id: p.tarea_id }),
      ...(p.acuerdo_id && { acuerdo_id: p.acuerdo_id }),
      ...(p.resuelta_por && { resuelta_por: p.resuelta_por }),
      ...(p.resuelta_en && { resuelta_en: p.resuelta_en }),
    };
    db.sembrar(tables.reuniones, item);
  }
}

test('GET propuestas/pendientes lista vía GSI y filtra sin Scan', async () => {
  const db = montar();
  sembrarReunionConPropuestas(db, {
    id: 'r-vis',
    propuestas: [
      { id_propuesta: 'p1', titulo: 'Pedir presupuesto' },
      { id_propuesta: 'p2', tipo: 'acuerdo', titulo: 'Congelar precios' },
    ],
  });
  // Reunión restringida a la que Ana no alcanza (convocante otro, sin autorizados).
  sembrarReunionConPropuestas(db, {
    id: 'r-ocult',
    visibilidad: 'restringida',
    convocadaPor: JEFE.sub,
    propuestas: [{ id_propuesta: 'p-ocult', titulo: 'Secreto' }],
  });
  // Sin cita: no debe salir.
  sembrarReunionConPropuestas(db, {
    id: 'r-sin-cita',
    propuestas: [{ id_propuesta: 'p-vacia', titulo: 'Sin cita', cita: '' }],
  });

  const r = await api('GET', '/api/reuniones/propuestas/pendientes');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.body.propuestas.map((p) => p.id_propuesta).sort();
  assert.deepEqual(ids, ['p1', 'p2']);
  assert.ok(r.body.propuestas.every((p) => p.cita));
  assert.ok(r.body.propuestas.every((p) => p.id_reunion === 'r-vis'));
  assert.equal(operacionesScan(db).length, 0);

  // Bea solo ver: sin reuniones.gestionar → 403 del middleware.
  const denegado = await api('GET', '/api/reuniones/propuestas/pendientes', undefined, BEA);
  assert.equal(denegado.status, 403);
});

test('cola pendientes rellena N visibles saltando ocultas (no página vacía con cursor)', async () => {
  const db = montar();
  // Primero varias ocultas (restringidas), luego una visible — con limite=1
  // la primera Query solo traería ocultas; debe seguir hasta encontrar la visible.
  for (let i = 0; i < 3; i += 1) {
    sembrarReunionConPropuestas(db, {
      id: `r-oc-${i}`,
      visibilidad: 'restringida',
      convocadaPor: JEFE.sub,
      propuestas: [
        {
          id_propuesta: `po-${i}`,
          titulo: `Oculta ${i}`,
          creado_en: `2026-08-20T09:0${i}:00.000Z`,
        },
      ],
    });
  }
  sembrarReunionConPropuestas(db, {
    id: 'r-ok',
    propuestas: [
      {
        id_propuesta: 'p-ok',
        titulo: 'Visible al final',
        creado_en: '2026-08-20T09:10:00.000Z',
      },
    ],
  });

  const r = await api('GET', '/api/reuniones/propuestas/pendientes?limite=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.propuestas.length, 1);
  assert.equal(r.body.propuestas[0].id_propuesta, 'p-ok');
  assert.equal(operacionesScan(db).length, 0);
});

test('GET :id/propuestas incluye pendientes y resueltas; ?estado=pendiente filtra', async () => {
  const db = montar();
  sembrarReunionConPropuestas(db, {
    id: 'r-lista',
    propuestas: [
      { id_propuesta: 'pa', titulo: 'Abierta' },
      {
        id_propuesta: 'pb',
        titulo: 'Ya aceptada',
        estado: 'aceptada',
        pendiente: false,
        tarea_id: 't-old',
        resuelta_por: ANA.sub,
        resuelta_en: '2026-08-20T12:00:00.000Z',
      },
    ],
  });

  const todas = await api('GET', '/api/reuniones/r-lista/propuestas');
  assert.equal(todas.status, 200);
  assert.equal(todas.body.propuestas.length, 2);
  const pb = todas.body.propuestas.find((p) => p.id_propuesta === 'pb');
  assert.equal(pb.propuesta_estado, 'aceptada');

  const pend = await api('GET', '/api/reuniones/r-lista/propuestas?estado=pendiente');
  assert.equal(pend.status, 200);
  assert.equal(pend.body.propuestas.length, 1);
  assert.equal(pend.body.propuestas[0].id_propuesta, 'pa');
  assert.equal(operacionesScan(db).length, 0);
});

test('resolver aceptar tarea crea con propuesta_origen_id; REMOVE sparse; idempotente', async () => {
  const db = montar();
  sembrarReunionConPropuestas(db, {
    id: 'r-acc',
    propuestas: [
      {
        id_propuesta: 'prop-tarea',
        titulo: 'Comprar sillas',
        responsable_sugerido_id: BEA.sub,
      },
    ],
  });

  const primera = await api('POST', '/api/reuniones/r-acc/propuestas/resolver', {
    decisiones: [{ id_propuesta: 'prop-tarea', accion: 'aceptar' }],
  });
  assert.equal(primera.status, 200, JSON.stringify(primera.body));
  assert.equal(primera.body.resueltas.length, 1);
  assert.equal(primera.body.resueltas[0].propuesta_estado, 'aceptada');
  assert.ok(primera.body.resueltas[0].tarea_id);
  assert.equal(primera.body.resueltas[0].omitida, false);

  const prop = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-acc'),
    SK: SK.propuesta('prop-tarea'),
  });
  // Sparse: el atributo GSI desaparece; el resultado vive en `estado`.
  assert.equal(prop.propuesta_estado, undefined);
  assert.equal(prop.estado, 'aceptada');
  assert.equal(prop.resuelta_por, ANA.sub);
  assert.ok(prop.resuelta_en);
  assert.equal(prop.tarea_id, primera.body.resueltas[0].tarea_id);

  const tarea = db.obtener(tables.tareas, {
    PK: PK.tarea(primera.body.resueltas[0].tarea_id),
    SK: SK.meta,
  });
  assert.equal(tarea.propuesta_origen_id, 'prop-tarea');
  assert.equal(tarea.reunion_origen_id, 'r-acc');
  assert.equal(tarea.responsable_id, BEA.sub);
  assert.ok(tarea.cita_origen);

  // Segunda pulsación: no duplica.
  const segunda = await api('POST', '/api/reuniones/r-acc/propuestas/resolver', {
    decisiones: [{ id_propuesta: 'prop-tarea', accion: 'aceptar' }],
  });
  assert.equal(segunda.status, 200, JSON.stringify(segunda.body));
  assert.equal(segunda.body.resueltas[0].omitida, true);
  assert.equal(segunda.body.resueltas[0].tarea_id, primera.body.resueltas[0].tarea_id);

  const tareas = db
    .listar(tables.tareas)
    .filter((t) => t.SK === 'META' && t.propuesta_origen_id === 'prop-tarea');
  assert.equal(tareas.length, 1);
  assert.equal(operacionesScan(db).length, 0);

  // Sale de la cola pendiente.
  const cola = await api('GET', '/api/reuniones/propuestas/pendientes');
  assert.equal(cola.body.propuestas.length, 0);
});

test('resolver rechazar y acuerdo: sparse + idempotencia sin segundo ACUERDO#', async () => {
  const db = montar();
  sembrarReunionConPropuestas(db, {
    id: 'r-mix',
    propuestas: [
      { id_propuesta: 'prop-rech', titulo: 'Idea mala' },
      {
        id_propuesta: 'prop-acu',
        tipo: 'acuerdo',
        titulo: 'Mantener márgenes',
        responsable_sugerido_id: ANA.sub,
      },
    ],
  });

  const r = await api('POST', '/api/reuniones/r-mix/propuestas/resolver', {
    decisiones: [
      { id_propuesta: 'prop-rech', accion: 'rechazar' },
      { id_propuesta: 'prop-acu', accion: 'aceptar' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resueltas.length, 2);

  const rechazada = r.body.resueltas.find((x) => x.id_propuesta === 'prop-rech');
  assert.equal(rechazada.propuesta_estado, 'rechazada');
  const filaRech = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-mix'),
    SK: SK.propuesta('prop-rech'),
  });
  assert.ok(filaRech);
  assert.equal(filaRech.propuesta_estado, undefined);
  assert.equal(filaRech.estado, 'rechazada');
  assert.ok(filaRech.cita);

  const aceptada = r.body.resueltas.find((x) => x.id_propuesta === 'prop-acu');
  assert.equal(aceptada.propuesta_estado, 'aceptada');
  assert.ok(aceptada.acuerdo_id);
  const acuerdo = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-mix'),
    SK: SK.acuerdo(aceptada.acuerdo_id),
  });
  assert.ok(acuerdo);
  assert.equal(acuerdo.texto, 'Mantener márgenes');
  assert.equal(acuerdo.propuesta_origen_id, 'prop-acu');
  assert.equal(acuerdo.estado, 'abierto');

  // Rechazar de nuevo es idempotente.
  const otra = await api('POST', '/api/reuniones/r-mix/propuestas/resolver', {
    decisiones: [{ id_propuesta: 'prop-rech', accion: 'rechazar' }],
  });
  assert.equal(otra.status, 200);
  assert.equal(otra.body.resueltas[0].omitida, true);

  // Re-aceptar el acuerdo no crea otro ACUERDO#.
  const reacu = await api('POST', '/api/reuniones/r-mix/propuestas/resolver', {
    decisiones: [{ id_propuesta: 'prop-acu', accion: 'aceptar' }],
  });
  assert.equal(reacu.status, 200, JSON.stringify(reacu.body));
  assert.equal(reacu.body.resueltas[0].omitida, true);
  assert.equal(reacu.body.resueltas[0].acuerdo_id, aceptada.acuerdo_id);
  const acuerdos = db
    .listar(tables.reuniones)
    .filter((it) => it.PK === PK.reunion('r-mix') && String(it.SK).startsWith('ACUERDO#'));
  assert.equal(acuerdos.length, 1);
  assert.equal(operacionesScan(db).length, 0);
});

test('aceptar con campos editados marca editada_y_aceptada en estado', async () => {
  const db = montar();
  sembrarReunionConPropuestas(db, {
    id: 'r-edit',
    propuestas: [
      {
        id_propuesta: 'prop-ed',
        titulo: 'Título IA',
        responsable_sugerido_id: ANA.sub,
      },
    ],
  });

  const r = await api('POST', '/api/reuniones/r-edit/propuestas/resolver', {
    decisiones: [
      {
        id_propuesta: 'prop-ed',
        accion: 'aceptar',
        titulo: 'Título corregido',
        responsable_id: BEA.sub,
      },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resueltas[0].propuesta_estado, 'editada_y_aceptada');

  const prop = db.obtener(tables.reuniones, {
    PK: PK.reunion('r-edit'),
    SK: SK.propuesta('prop-ed'),
  });
  assert.equal(prop.propuesta_estado, undefined);
  assert.equal(prop.estado, 'editada_y_aceptada');

  const tarea = db.obtener(tables.tareas, {
    PK: PK.tarea(r.body.resueltas[0].tarea_id),
    SK: SK.meta,
  });
  assert.equal(tarea.titulo, 'Título corregido');
  assert.equal(tarea.responsable_id, BEA.sub);
});
