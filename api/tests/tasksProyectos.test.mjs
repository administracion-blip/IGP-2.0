/**
 * Proyectos del módulo de dirección (Fase 1A).
 *
 * Lo que se fija aquí no es que el CRUD escriba, sino las reglas que hacen que
 * el módulo no filtre ni se rompa:
 *
 * - **Participar es lo que da acceso.** Quien no es miembro y no tiene
 *   `tareas.ver_todas` no ve el proyecto, ni listando ni pidiéndolo por id, y el
 *   filtro por estado no es una puerta lateral para colarse.
 * - **El observador nunca edita**, tenga el permiso global que tenga.
 * - **El presupuesto no viaja sin `proyectos.presupuesto_ver`**: el campo se
 *   omite, no se manda a cero.
 * - **Comprometido y real se calculan** sumando las líneas `COMPRA#`. No hay
 *   contador guardado que pueda desincronizarse.
 * - **Un proyecto no se queda sin responsable** ni sin cabecera: quitar al único
 *   responsable responde `409`. Borrar el proyecto se lleva sus tareas.
 * - **`gsi_listado` solo va en el `META`**, que es lo que mantiene el índice de
 *   listado con un ítem por proyecto.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-proyectos';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { default: proyectosRouter } = await import('../routes/proyectos.js');

/** Administrador: `requirePermission` y la capa de acceso lo dan todo por bueno. */
const JEFE = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
/** Con todos los permisos de proyectos, incluido el de presupuesto. */
const ANA = { sub: '000007', email: 'ana@grupo.test', rol: 'Jefa de proyectos' };
/** Puede editar proyectos… salvo aquellos en los que es observadora. */
const BEA = { sub: '000008', email: 'bea@grupo.test', rol: 'Coordinadora' };
/** Entra al módulo y nada más: el ajeno que no debe ver proyectos de otros. */
const CARLOS = { sub: '000009', email: 'carlos@grupo.test', rol: 'Camarero' };
/** Ve todo sin ser miembro, por `tareas.ver_todas`. */
const AUDITORA = { sub: '000010', email: 'auditora@grupo.test', rol: 'Auditoría' };

const PERMISOS_POR_ROL = {
  'Jefa de proyectos': [
    'proyectos.ver',
    'proyectos.crear',
    'proyectos.editar',
    'proyectos.borrar',
    'proyectos.presupuesto_ver',
  ],
  Coordinadora: ['proyectos.ver', 'proyectos.editar', 'proyectos.borrar'],
  Camarero: ['proyectos.ver'],
  Auditoría: ['proyectos.ver', 'tareas.ver_todas'],
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

/** `paginaTam` fuerza la paginación, para ejercitar cursores y bucles. */
function montar({ paginaTam = 0 } = {}) {
  const db = crearDynamoMemoria({ paginaTam });
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
    indices: { 'Proyecto-index': { hashKey: 'proyecto_id', rangeKey: 'sk_proyecto' } },
  });
  db.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.notificaciones, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: {
      'NoLeidas-index': { hashKey: 'usuario_no_leida', rangeKey: 'creado_en', proyeccion: 'KEYS_ONLY' },
    },
  });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });

  for (const u of [JEFE, ANA, BEA, CARLOS, AUDITORA]) {
    db.sembrar(tables.usuarios, { id_usuario: u.sub, Email: u.email, Rol: u.rol });
  }
  for (const [rol, codigos] of Object.entries(PERMISOS_POR_ROL)) {
    for (const codigo of codigos) {
      db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${codigo}` });
    }
  }

  db.instalar(docClient);
  // El contexto de acceso se cachea un minuto por usuario: entre pruebas se tira.
  invalidarContextoAcceso();
  return db;
}

function sembrarProyecto(
  db,
  {
    id,
    nombre = 'Reforma barra',
    estado = 'activo',
    responsable = ANA.sub,
    departamento = '',
    presupuesto,
    actualizado = '2026-08-01T10:00:00.000Z',
    miembros = [[ANA.sub, 'responsable']],
    compras = [],
  },
) {
  db.sembrar(tables.proyectos, {
    PK: `PROY#${id}`,
    SK: 'META',
    id_proyecto: id,
    nombre,
    estado,
    prioridad: 'media',
    ...(responsable && { responsable_id: responsable }),
    ...(departamento && { departamento_id: departamento }),
    ...(presupuesto !== undefined && { presupuesto_asignado: presupuesto }),
    creado_por: responsable,
    creado_en: actualizado,
    actualizado_en: actualizado,
    gsi_listado: 'PROY',
  });
  for (const [usuario, rol] of miembros) {
    db.sembrar(tables.proyectos, {
      PK: `PROY#${id}`,
      SK: `MIEMBRO#${usuario}`,
      usuario_id: usuario,
      rol_proyecto: rol,
      añadido_por: responsable,
      añadido_en: actualizado,
    });
  }
  for (const linea of compras) {
    db.sembrar(tables.proyectos, {
      PK: `PROY#${id}`,
      SK: `COMPRA#${linea.id_linea}`,
      ...linea,
    });
  }
  return id;
}

function meta(db, id) {
  return db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: 'META' });
}

function filasDe(db, id) {
  return db.listar(tables.proyectos).filter((it) => it.PK === `PROY#${id}`);
}

// ─── Visibilidad ───

test('quien no participa y no tiene tareas.ver_todas no ve el proyecto ni listando ni por id', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const lista = await api('GET', '/api/proyectos', undefined, CARLOS);
  assert.equal(lista.status, 200, 'tiene proyectos.ver: entra al listado, pero vacío');
  assert.deepEqual(lista.body.proyectos, []);

  // `404`, no `403`: un 403 confirmaría que el proyecto existe a quien no le
  // corresponde saberlo, y el router de tareas responde igual.
  const ficha = await api('GET', '/api/proyectos/p1', undefined, CARLOS);
  assert.equal(ficha.status, 404);
  assert.ok(ficha.body.error);

  const suyo = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(suyo.status, 200);
  assert.equal(suyo.body.proyecto.nombre, 'Reforma barra');
});

test('tareas.ver_todas alcanza proyectos en los que no se participa', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const ficha = await api('GET', '/api/proyectos/p1', undefined, AUDITORA);
  assert.equal(ficha.status, 200);
  const lista = await api('GET', '/api/proyectos', undefined, AUDITORA);
  assert.deepEqual(lista.body.proyectos.map((p) => p.id_proyecto), ['p1']);
});

test('un observador no puede editar el proyecto aunque tenga proyectos.editar', async () => {
  const db = montar();
  sembrarProyecto(db, {
    id: 'p1',
    miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'observador']],
  });

  const ver = await api('GET', '/api/proyectos/p1', undefined, BEA);
  assert.equal(ver.status, 200, 'observar es ver');

  const edicion = await api('PATCH', '/api/proyectos/p1', { nombre: 'Otro nombre' }, BEA);
  assert.equal(edicion.status, 403);
  assert.equal(meta(db, 'p1').nombre, 'Reforma barra');

  const alta = await api('POST', '/api/proyectos/p1/miembros', { usuario_id: CARLOS.sub }, BEA);
  assert.equal(alta.status, 403, 'gestionar miembros es editar');
});

test('un miembro con proyectos.editar sí edita', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'miembro']] });

  const edicion = await api('PATCH', '/api/proyectos/p1', { nombre: 'Reforma barra y sala' }, BEA);
  assert.equal(edicion.status, 200);
  assert.equal(meta(db, 'p1').nombre, 'Reforma barra y sala');
});

test('el proyecto que no existe responde 404, no 403', async () => {
  montar();
  assert.equal((await api('GET', '/api/proyectos/fantasma')).status, 404);
  assert.equal((await api('PATCH', '/api/proyectos/fantasma', { nombre: 'X' })).status, 404);
  assert.equal((await api('DELETE', '/api/proyectos/fantasma')).status, 404);
  assert.equal((await api('GET', '/api/proyectos/fantasma/actividad')).status, 404);
});

test('crear y borrar exigen su permiso global antes de mirar la fila', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  // Camarero solo tiene `proyectos.ver`: no tiene `proyectos.crear` ni
  // `proyectos.borrar`, y esos dos siguen siendo permiso de ruta.
  assert.equal((await api('POST', '/api/proyectos', { nombre: 'Nuevo' }, CARLOS)).status, 403);
  assert.equal((await api('DELETE', '/api/proyectos/p1', undefined, CARLOS)).status, 403);
  assert.equal(filasDe(db, 'p1').length, 2, 'nada se ha tocado');
});

test('la edición del proyecto la decide la ACL de fila: 404 si no lo ve, 403 si lo ve y no puede', async () => {
  const db = montar();
  // Carlos no participa en `p1` y es observador de `p2`.
  sembrarProyecto(db, { id: 'p1' });
  sembrarProyecto(db, {
    id: 'p2',
    miembros: [[ANA.sub, 'responsable'], [CARLOS.sub, 'observador']],
  });

  // Lo que no se ve responde 404, no 403 (D-16): un 403 confirmaría que existe.
  for (const [metodo, ruta, cuerpo] of [
    ['PATCH', '/api/proyectos/p1', { nombre: 'Nuevo' }],
    ['POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub }],
    ['DELETE', `/api/proyectos/p1/miembros/${ANA.sub}`, undefined],
    ['POST', '/api/proyectos/p1/vinculos', { tipo: 'local', id: '1' }],
    ['DELETE', '/api/proyectos/p1/vinculos/local/1', undefined],
  ]) {
    const r = await api(metodo, ruta, cuerpo, CARLOS);
    assert.equal(r.status, 404, `${metodo} ${ruta}`);
  }

  // Lo que se ve y no se puede tocar responde 403: ninguna de estas rutas se
  // quedó sin comprobación al quitarles el permiso global.
  for (const [metodo, ruta, cuerpo] of [
    ['PATCH', '/api/proyectos/p2', { nombre: 'Nuevo' }],
    ['POST', '/api/proyectos/p2/miembros', { usuario_id: BEA.sub }],
    ['DELETE', `/api/proyectos/p2/miembros/${ANA.sub}`, undefined],
    ['POST', '/api/proyectos/p2/vinculos', { tipo: 'local', id: '1' }],
    ['DELETE', '/api/proyectos/p2/vinculos/local/1', undefined],
  ]) {
    const r = await api(metodo, ruta, cuerpo, CARLOS);
    assert.equal(r.status, 403, `${metodo} ${ruta}`);
  }

  assert.equal(filasDe(db, 'p1').length, 2, 'nada se ha tocado');
  assert.equal(filasDe(db, 'p2').length, 3);
});

test('el responsable gestiona su proyecto sin proyectos.editar, de punta a punta', async () => {
  // Es el caso que rompía: dirección crea el proyecto y nombra responsable a
  // alguien con `proyectos.ver` y nada más. La ficha le decía
  // `permisos_fila.editar: true`, la pantalla le pintaba los botones y todos
  // respondían 403.
  const db = montar();
  sembrarProyecto(db, {
    id: 'p1',
    responsable: CARLOS.sub,
    miembros: [[CARLOS.sub, 'responsable']],
  });

  const ficha = await api('GET', '/api/proyectos/p1', undefined, CARLOS);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.proyecto.permisos_fila.editar, true);

  const edicion = await api('PATCH', '/api/proyectos/p1', { nombre: 'Reforma barra y sala' }, CARLOS);
  assert.equal(edicion.status, 200, JSON.stringify(edicion.body));
  assert.equal(meta(db, 'p1').nombre, 'Reforma barra y sala');

  const alta = await api('POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub }, CARLOS);
  assert.equal(alta.status, 200, JSON.stringify(alta.body));
  const baja = await api('DELETE', `/api/proyectos/p1/miembros/${BEA.sub}`, undefined, CARLOS);
  assert.equal(baja.status, 200);

  const vinculo = await api('POST', '/api/proyectos/p1/vinculos', { tipo: 'local', id: '1' }, CARLOS);
  assert.equal(vinculo.status, 200, JSON.stringify(vinculo.body));
  const quitado = await api('DELETE', '/api/proyectos/p1/vinculos/local/1', undefined, CARLOS);
  assert.equal(quitado.status, 200);

  // Lo que sigue exigiendo permiso global es borrar el proyecto entero.
  assert.equal((await api('DELETE', '/api/proyectos/p1', undefined, CARLOS)).status, 403);
});

// ─── Presupuesto y gasto ───

test('el presupuesto no aparece sin proyectos.presupuesto_ver', async () => {
  const db = montar();
  sembrarProyecto(db, {
    id: 'p1',
    presupuesto: 5000,
    miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'miembro']],
  });

  const conPermiso = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(conPermiso.body.proyecto.presupuesto_asignado, 5000);

  const sinPermiso = await api('GET', '/api/proyectos/p1', undefined, BEA);
  assert.equal(sinPermiso.status, 200, 've el proyecto: lo que no ve es el importe');
  assert.equal(
    'presupuesto_asignado' in sinPermiso.body.proyecto,
    false,
    'el campo se omite; un cero sería un dato falso',
  );
  assert.equal('gasto_comprometido' in sinPermiso.body.proyecto, false);
  assert.equal('gasto_real' in sinPermiso.body.proyecto, false);

  const lista = await api('GET', '/api/proyectos', undefined, BEA);
  assert.equal('presupuesto_asignado' in lista.body.proyectos[0], false, 'tampoco por el listado');
});

test('sin permiso de presupuesto no se puede asignar ni cambiar el importe', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'miembro']] });

  const alta = await api('POST', '/api/proyectos', { nombre: 'Con dinero', presupuesto_asignado: 100 }, BEA);
  assert.equal(alta.status, 403, 'Coordinadora no tiene proyectos.crear');

  const cambio = await api('PATCH', '/api/proyectos/p1', { presupuesto_asignado: 999 }, BEA);
  assert.equal(cambio.status, 403);
  assert.equal(meta(db, 'p1').presupuesto_asignado, undefined);
});

test('comprometido y real se suman de las líneas de compra y no se guardan', async () => {
  const db = montar();
  sembrarProyecto(db, {
    id: 'p1',
    presupuesto: 1000,
    compras: [
      { id_linea: 'l1', compra_estado: 'aprobada', precio_total_estimado: 100 },
      { id_linea: 'l2', compra_estado: 'pedida', cantidad: 2, precio_unitario_estimado: 25 },
      { id_linea: 'l3', compra_estado: 'propuesta', precio_total_estimado: 999 },
      { id_linea: 'l4', compra_estado: 'rechazada', precio_total_estimado: 999 },
      { id_linea: 'l5', compra_estado: 'recibida', precio_total_estimado: 60, precio_real: 70.5 },
    ],
  });

  const ficha = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.proyecto.gasto_comprometido, 150, 'aprobada + pedida, por importe estimado');
  assert.equal(ficha.body.proyecto.gasto_real, 70.5, 'solo lo recibido, por su precio real');

  // Ni contador denormalizado en el ítem, ni líneas de compra en la respuesta:
  // sus endpoints son de Fase 4.
  assert.equal(meta(db, 'p1').gasto_comprometido, undefined);
  assert.equal(meta(db, 'p1').gasto_real, undefined);
  assert.equal('compras' in ficha.body, false);
});

test('un proyecto sin líneas de compra devuelve los dos totales a cero', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });
  const ficha = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(ficha.body.proyecto.gasto_comprometido, 0);
  assert.equal(ficha.body.proyecto.gasto_real, 0);
});

// ─── Alta ───

test('quien crea el proyecto queda como miembro responsable', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', { nombre: '  Obra   nueva  ' }, ANA);

  assert.equal(alta.status, 200);
  const id = alta.body.proyecto.id_proyecto;
  assert.ok(id.length > 10, 'el id es un UUID, no un slug del nombre');
  assert.equal(alta.body.proyecto.nombre, 'Obra nueva');
  assert.equal(alta.body.proyecto.estado, 'borrador');
  assert.equal(alta.body.proyecto.prioridad, 'media');
  assert.equal(alta.body.proyecto.responsable_id, ANA.sub);

  const miembro = db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: `MIEMBRO#${ANA.sub}` });
  assert.equal(miembro.rol_proyecto, 'responsable');

  const mios = await api('GET', '/api/proyectos/mios', undefined, ANA);
  assert.deepEqual(mios.body.proyectos.map((p) => p.id_proyecto), [id]);
});

test('si el alta nombra a otro responsable, quien la hizo entra como miembro', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', { nombre: 'Obra nueva', responsable_id: BEA.sub }, ANA);
  const id = alta.body.proyecto.id_proyecto;

  assert.equal(alta.body.proyecto.responsable_id, BEA.sub);
  assert.equal(db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: `MIEMBRO#${BEA.sub}` }).rol_proyecto, 'responsable');
  // Si no entrara, quien acaba de crear el proyecto no podría ni abrirlo.
  assert.equal(db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: `MIEMBRO#${ANA.sub}` }).rol_proyecto, 'miembro');
  assert.equal((await api('GET', `/api/proyectos/${id}`, undefined, ANA)).status, 200);
});

test('el alta valida estados, prioridades, fechas e importes con mensaje en español', async () => {
  const db = montar();
  const casos = [
    { nombre: '' },
    { nombre: '   ' },
    { nombre: 'X', estado: 'archivado' },
    { nombre: 'X', prioridad: 'urgentísima' },
    { nombre: 'X', fecha_inicio: '01/09/2026' },
    { nombre: 'X', fecha_fin_prevista: '2026-02-31' },
    { nombre: 'X', presupuesto_asignado: 'mucho' },
    { nombre: 'X', presupuesto_asignado: -1 },
  ];
  for (const cuerpo of casos) {
    const r = await api('POST', '/api/proyectos', cuerpo, ANA);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
    assert.ok(r.body.error, JSON.stringify(cuerpo));
  }
  assert.equal(db.listar(tables.proyectos).length, 0, 'ninguno de los inválidos ha escrito nada');
});

test('las fechas se guardan como día, aunque lleguen con hora', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', {
    nombre: 'Obra',
    fecha_inicio: '2026-09-01T08:30:00.000Z',
    fecha_fin_prevista: '2026-12-31',
  });
  const guardado = meta(db, alta.body.proyecto.id_proyecto);
  assert.equal(guardado.fecha_inicio, '2026-09-01');
  assert.equal(guardado.fecha_fin_prevista, '2026-12-31');
});

// ─── Edición ───

test('gsi_listado va solo en el ítem META', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', { nombre: 'Obra' }, ANA);
  const id = alta.body.proyecto.id_proyecto;
  await api('POST', `/api/proyectos/${id}/miembros`, { usuario_id: BEA.sub, rol_proyecto: 'miembro' }, ANA);
  await api('POST', `/api/proyectos/${id}/vinculos`, { tipo: 'proveedor', id: '77', etiqueta: 'Distribuciones Sur' }, ANA);

  const filas = filasDe(db, id);
  assert.ok(filas.length >= 4);
  for (const fila of filas) {
    if (fila.SK === 'META') assert.equal(fila.gsi_listado, 'PROY');
    else assert.equal(fila.gsi_listado, undefined, `${fila.SK} no debe indexarse en el listado`);
  }

  // Y por eso el índice devuelve un ítem por proyecto, no uno por fila.
  const lista = await api('GET', '/api/proyectos', undefined, ANA);
  assert.equal(lista.body.proyectos.length, 1);
});

test('toda escritura sube actualizado_en, que es el orden del listado', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', actualizado: '2026-08-01T10:00:00.000Z' });

  await api('POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub }, ANA);
  const trasMiembro = meta(db, 'p1').actualizado_en;
  assert.ok(trasMiembro > '2026-08-01T10:00:00.000Z', 'añadir un miembro es actividad del proyecto');

  await api('POST', '/api/proyectos/p1/vinculos', { tipo: 'local', id: '3' }, ANA);
  assert.ok(meta(db, 'p1').actualizado_en >= trasMiembro);
});

test('cerrar el proyecto rellena la fecha de cierre y deja entrada de estado', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const r = await api('PATCH', '/api/proyectos/p1', { estado: 'cerrado' }, ANA);
  assert.equal(r.status, 200);
  assert.equal(r.body.proyecto.estado, 'cerrado');
  assert.match(meta(db, 'p1').fecha_cierre, /^\d{4}-\d{2}-\d{2}$/);

  const historial = await api('GET', '/api/proyectos/p1/actividad', undefined, ANA);
  assert.equal(historial.body.actividad[0].accion, 'estado_cambiado');
  assert.match(historial.body.actividad[0].detalle, /"antes":"activo".*"despues":"cerrado"/);
});

test('el PATCH guarda el antes y el después en el historial', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  await api('PATCH', '/api/proyectos/p1', { nombre: 'Reforma sala', prioridad: 'alta' }, ANA);
  const historial = await api('GET', '/api/proyectos/p1/actividad', undefined, ANA);
  const edicion = historial.body.actividad.find((a) => a.accion === 'editada');
  assert.ok(edicion, 'la edición se registra');
  const detalle = JSON.parse(edicion.detalle);
  assert.equal(detalle.antes.nombre, 'Reforma barra');
  assert.equal(detalle.despues.nombre, 'Reforma sala');
  assert.equal(detalle.despues.prioridad, 'alta');
});

test('un PATCH sin campos conocidos no vale como edición', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });
  const r = await api('PATCH', '/api/proyectos/p1', { inventado: true }, ANA);
  assert.equal(r.status, 400);
  assert.equal(meta(db, 'p1').nombre, 'Reforma barra');
});

test('vaciar un campo de texto lo borra del ítem, no lo deja en blanco', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', departamento: 'mkt' });
  const r = await api('PATCH', '/api/proyectos/p1', { departamento_id: '' }, ANA);
  assert.equal(r.status, 200);
  assert.equal(meta(db, 'p1').departamento_id, undefined);
});

test('cambiar de responsable le crea su fila de miembro', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const r = await api('PATCH', '/api/proyectos/p1', { responsable_id: BEA.sub }, ANA);
  assert.equal(r.status, 200);
  assert.equal(meta(db, 'p1').responsable_id, BEA.sub);
  // Sin la fila no saldría en el `Miembro-index` y «mis proyectos» no le
  // mostraría el proyecto que dirige.
  const suyos = await api('GET', '/api/proyectos/mios', undefined, BEA);
  assert.deepEqual(suyos.body.proyectos.map((p) => p.id_proyecto), ['p1']);
});

test('vaciar el responsable sin ningún miembro que lo sea responde 409', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'miembro']] });

  const r = await api('PATCH', '/api/proyectos/p1', { responsable_id: '' }, ANA);
  assert.equal(r.status, 409);
  assert.equal(meta(db, 'p1').responsable_id, ANA.sub);
});

// ─── Miembros ───

test('quitar al único responsable responde 409', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', { nombre: 'Obra' }, ANA);
  const id = alta.body.proyecto.id_proyecto;

  const solo = await api('DELETE', `/api/proyectos/${id}/miembros/${ANA.sub}`, undefined, ANA);
  assert.equal(solo.status, 409);
  assert.ok(db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: `MIEMBRO#${ANA.sub}` }));

  // Con otro responsable en el equipo, la baja sí sale.
  await api('POST', `/api/proyectos/${id}/miembros`, { usuario_id: BEA.sub, rol_proyecto: 'responsable' }, ANA);
  const conRelevo = await api('DELETE', `/api/proyectos/${id}/miembros/${ANA.sub}`, undefined, ANA);
  assert.equal(conRelevo.status, 200);
  assert.equal(db.obtener(tables.proyectos, { PK: `PROY#${id}`, SK: `MIEMBRO#${ANA.sub}` }), null);
});

test('quitar a un observador no exige relevo, y quitar a quien no es miembro es 404', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'observador']] });

  assert.equal((await api('DELETE', `/api/proyectos/p1/miembros/${BEA.sub}`, undefined, ANA)).status, 200);
  assert.equal((await api('DELETE', `/api/proyectos/p1/miembros/${CARLOS.sub}`, undefined, ANA)).status, 404);
});

test('el rol de miembro se valida y repetir el alta cambia el rol sin duplicar fila', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const invalido = await api('POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub, rol_proyecto: 'jefa' }, ANA);
  assert.equal(invalido.status, 400);
  const sinUsuario = await api('POST', '/api/proyectos/p1/miembros', { rol_proyecto: 'miembro' }, ANA);
  assert.equal(sinUsuario.status, 400);

  await api('POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub }, ANA);
  await api('POST', '/api/proyectos/p1/miembros', { usuario_id: BEA.sub, rol_proyecto: 'observador' }, ANA);
  const suyas = filasDe(db, 'p1').filter((f) => f.SK === `MIEMBRO#${BEA.sub}`);
  assert.equal(suyas.length, 1);
  assert.equal(suyas[0].rol_proyecto, 'observador');
});

// ─── Vínculos ───

test('el vínculo se guarda con la clave de su índice y se puede quitar', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  const alta = await api('POST', '/api/proyectos/p1/vinculos', { tipo: 'proveedor', id: '77', etiqueta: 'Distribuciones Sur' }, ANA);
  assert.equal(alta.status, 200);
  assert.deepEqual(
    { tipo: alta.body.vinculo.tipo, id: alta.body.vinculo.id, etiqueta: alta.body.vinculo.etiqueta },
    { tipo: 'proveedor', id: '77', etiqueta: 'Distribuciones Sur' },
  );
  const fila = db.obtener(tables.proyectos, { PK: 'PROY#p1', SK: 'VINC#proveedor#77' });
  assert.equal(fila.vinculo_clave, 'proveedor#77');
  assert.equal('vinculo_clave' in alta.body.vinculo, false, 'la clave del índice no sale al cliente');

  const ficha = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(ficha.body.vinculos.length, 1);

  assert.equal((await api('DELETE', '/api/proyectos/p1/vinculos/proveedor/77', undefined, ANA)).status, 200);
  assert.equal(db.obtener(tables.proyectos, { PK: 'PROY#p1', SK: 'VINC#proveedor#77' }), null);
  assert.equal((await api('DELETE', '/api/proyectos/p1/vinculos/proveedor/77', undefined, ANA)).status, 404);
});

test('un tipo de vínculo que no está en la lista se rechaza con 400', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });

  for (const cuerpo of [{ tipo: 'nevera', id: '1' }, { tipo: 'proveedor' }, { tipo: '', id: '1' }]) {
    const r = await api('POST', '/api/proyectos/p1/vinculos', cuerpo, ANA);
    assert.equal(r.status, 400, JSON.stringify(cuerpo));
  }
  assert.equal(filasDe(db, 'p1').length, 2);
});

// ─── Borrado ───

test('borrar un proyecto con tareas se lleva también esas tareas', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });
  db.sembrar(tables.tareas, {
    PK: 'TAREA#t1',
    SK: 'META',
    id_tarea: 't1',
    titulo: 'Cartel',
    proyecto_id: 'p1',
    sk_proyecto: 'abierta#2026-09-01#t1',
    estado: 'pendiente',
  });
  db.sembrar(tables.tareas, {
    PK: 'TAREA#t1',
    SK: 'ADJ#a1',
    s3_key: 'tareas/t1/a1.pdf',
  });
  db.sembrar(tables.tareas, {
    PK: 'TAREA#t9',
    SK: 'META',
    id_tarea: 't9',
    proyecto_id: 'otro',
    sk_proyecto: 'abierta#2026-09-01#t9',
  });

  const r = await api('DELETE', '/api/proyectos/p1', undefined, ANA);
  assert.equal(r.status, 200);
  assert.equal(r.body.tareas_borradas, 1);
  assert.deepEqual(filasDe(db, 'p1'), []);
  assert.equal(db.listar(tables.tareas).filter((t) => t.PK === 'TAREA#t1').length, 0);
  assert.ok(db.listar(tables.tareas).some((t) => t.PK === 'TAREA#t9'), 'la de otro proyecto no se toca');
});

test('borrar un proyecto sin tareas se lleva la partición entera', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'miembro']] });
  await api('POST', '/api/proyectos/p1/vinculos', { tipo: 'local', id: '3' }, ANA);
  // Tarea de otro proyecto: no puede frenar este borrado.
  db.sembrar(tables.tareas, {
    PK: 'TAREA#t9',
    SK: 'META',
    proyecto_id: 'otro',
    sk_proyecto: 'abierta#2026-09-01#t9',
  });

  const r = await api('DELETE', '/api/proyectos/p1', undefined, ANA);
  assert.equal(r.status, 200);
  assert.deepEqual(filasDe(db, 'p1'), [], 'META, miembros y vínculos');

  // El historial es append-only: sobrevive a la entidad.
  const historial = db.listar(tables.actividad).filter((a) => a.PK === 'PROY#p1');
  assert.ok(historial.some((a) => a.accion === 'borrada'));
});

test('cancelar un proyecto con tareas es la vía: el PATCH de estado sí pasa', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });
  db.sembrar(tables.tareas, {
    PK: 'TAREA#t1',
    SK: 'META',
    proyecto_id: 'p1',
    sk_proyecto: 'abierta#2026-09-01#t1',
  });

  const r = await api('PATCH', '/api/proyectos/p1', { estado: 'cancelado' }, ANA);
  assert.equal(r.status, 200);
  assert.equal(meta(db, 'p1').estado, 'cancelado');
});

// ─── Listado ───

test('el listado pagina y el filtro por estado no se salta la visibilidad', async () => {
  const db = montar({ paginaTam: 2 });
  sembrarProyecto(db, { id: 'p1', estado: 'activo', actualizado: '2026-08-03T10:00:00.000Z' });
  sembrarProyecto(db, { id: 'p2', estado: 'cerrado', actualizado: '2026-08-02T10:00:00.000Z' });
  // Ajeno a Ana y, además, con el estado por el que va a filtrar.
  sembrarProyecto(db, {
    id: 'p3',
    estado: 'activo',
    responsable: CARLOS.sub,
    miembros: [[CARLOS.sub, 'responsable']],
    actualizado: '2026-08-01T10:00:00.000Z',
  });

  const primera = await api('GET', '/api/proyectos?estado=activo', undefined, ANA);
  assert.equal(primera.status, 200);
  assert.deepEqual(primera.body.proyectos.map((p) => p.id_proyecto), ['p1']);
  assert.ok(primera.body.cursor, 'quedan páginas por recorrer');

  const segunda = await api(
    'GET',
    `/api/proyectos?estado=activo&cursor=${encodeURIComponent(primera.body.cursor)}`,
    undefined,
    ANA,
  );
  assert.deepEqual(segunda.body.proyectos, [], 'p3 es visible para Carlos, no para Ana');
  assert.equal(segunda.body.cursor, null);
});

test('el listado va por actividad reciente y admite filtrar por departamento y responsable', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', departamento: 'mkt', actualizado: '2026-08-01T10:00:00.000Z' });
  sembrarProyecto(db, { id: 'p2', departamento: 'rrhh', actualizado: '2026-08-05T10:00:00.000Z' });
  sembrarProyecto(db, {
    id: 'p3',
    departamento: 'mkt',
    responsable: BEA.sub,
    miembros: [[ANA.sub, 'miembro'], [BEA.sub, 'responsable']],
    actualizado: '2026-08-03T10:00:00.000Z',
  });

  const todos = await api('GET', '/api/proyectos', undefined, ANA);
  assert.deepEqual(todos.body.proyectos.map((p) => p.id_proyecto), ['p2', 'p3', 'p1']);

  const marketing = await api('GET', '/api/proyectos?departamento=mkt', undefined, ANA);
  assert.deepEqual(marketing.body.proyectos.map((p) => p.id_proyecto), ['p3', 'p1']);

  const deBea = await api('GET', `/api/proyectos?responsable=${BEA.sub}`, undefined, ANA);
  assert.deepEqual(deBea.body.proyectos.map((p) => p.id_proyecto), ['p3']);
});

test('un estado de filtro que no existe se rechaza con 400', async () => {
  montar();
  const r = await api('GET', '/api/proyectos?estado=archivado', undefined, ANA);
  assert.equal(r.status, 400);
});

test('mios devuelve solo los proyectos en los que se participa', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1', actualizado: '2026-08-01T10:00:00.000Z' });
  sembrarProyecto(db, {
    id: 'p2',
    responsable: BEA.sub,
    miembros: [[BEA.sub, 'responsable'], [ANA.sub, 'observador']],
    actualizado: '2026-08-04T10:00:00.000Z',
  });
  sembrarProyecto(db, {
    id: 'p3',
    responsable: CARLOS.sub,
    miembros: [[CARLOS.sub, 'responsable']],
  });

  const mios = await api('GET', '/api/proyectos/mios', undefined, ANA);
  assert.deepEqual(mios.body.proyectos.map((p) => p.id_proyecto), ['p2', 'p1']);

  // Ni siquiera con `tareas.ver_todas`: «mios» es participación, no alcance.
  const deLaAuditora = await api('GET', '/api/proyectos/mios', undefined, AUDITORA);
  assert.deepEqual(deLaAuditora.body.proyectos, []);
});

// ─── Nombres y permisos de fila ───

test('la ficha resuelve el nombre del responsable y de cada miembro en un solo lote', async () => {
  const db = montar();
  // Nombre y apellidos cuando están; el email es el último recurso, igual que en
  // el maestro de departamentos.
  db.sembrar(tables.usuarios, {
    id_usuario: ANA.sub,
    Email: ANA.email,
    Nombre: 'Ana',
    Apellidos: 'Ruiz',
    Rol: ANA.rol,
  });
  sembrarProyecto(db, { id: 'p1', miembros: [[ANA.sub, 'responsable'], [BEA.sub, 'observador']] });

  // Una primera llamada deja el contexto de acceso en caché: su lectura del
  // usuario no es de la ficha y ensuciaría la cuenta.
  await api('GET', '/api/proyectos/p1', undefined, ANA);
  const antes = db.operaciones.length;

  const ficha = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.proyecto.responsable_nombre, 'Ana Ruiz');
  assert.deepEqual(
    ficha.body.miembros.map((m) => m.usuario_nombre),
    ['Ana Ruiz', BEA.email],
  );

  // La responsable y los dos miembros salen de un único BatchGet: un Get por
  // fila convertiría la ficha de un equipo de doce en trece lecturas.
  const nuevas = db.operaciones.slice(antes);
  const lotes = nuevas.filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(lotes.length, 1, 'una sola lectura de usuarios para toda la ficha');
  assert.equal(lotes[0].claves, 2, 'la responsable, que además es miembro, no se pide dos veces');
  assert.equal(
    nuevas.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.usuarios).length,
    0,
    'nada de una lectura por fila',
  );
});

test('el listado resuelve los nombres de varios responsables en un lote, no uno por proyecto', async () => {
  const db = montar();
  for (let i = 0; i < 6; i += 1) {
    const responsable = i % 2 === 0 ? ANA.sub : BEA.sub;
    sembrarProyecto(db, {
      id: `p${i}`,
      nombre: `Proyecto ${i}`,
      responsable,
      miembros: [[responsable, 'responsable'], [ANA.sub, 'miembro']],
      actualizado: `2026-08-0${i + 1}T10:00:00.000Z`,
    });
  }
  await api('GET', '/api/proyectos', undefined, ANA);
  const antes = db.operaciones.length;

  const lista = await api('GET', '/api/proyectos', undefined, ANA);
  assert.equal(lista.status, 200);
  assert.equal(lista.body.proyectos.length, 6);
  assert.deepEqual(
    [...new Set(lista.body.proyectos.map((p) => p.responsable_nombre))].sort(),
    [ANA.email, BEA.email].sort(),
  );

  const nuevas = db.operaciones.slice(antes);
  const lotes = nuevas.filter((o) => o.tipo === 'BatchGetCommand');
  assert.equal(lotes.length, 2, 'la pertenencia de quien pregunta y, aparte, los nombres');
  assert.equal(lotes[1].claves, 2, 'seis proyectos de dos responsables son dos claves');
  assert.equal(
    nuevas.filter((o) => o.tipo === 'GetCommand' && o.tabla === tables.usuarios).length,
    0,
  );
});

test('un usuario dado de baja deja el nombre en null sin romper ficha ni listado', async () => {
  const db = montar();
  // No hay integridad referencial contra `igp_usuarios`: el identificador puede
  // apuntar a alguien que ya no está.
  sembrarProyecto(db, {
    id: 'p1',
    responsable: '000404',
    miembros: [['000404', 'responsable'], [ANA.sub, 'miembro']],
  });

  const lista = await api('GET', '/api/proyectos', undefined, ANA);
  assert.equal(lista.status, 200);
  assert.equal(lista.body.proyectos[0].responsable_nombre, null);

  const ficha = await api('GET', '/api/proyectos/p1', undefined, ANA);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.body.proyecto.responsable_nombre, null);
  assert.equal(
    ficha.body.miembros.find((m) => m.usuario_id === '000404').usuario_nombre,
    null,
  );
});

test('permisos_fila deja editar al responsable del proyecto aunque no tenga proyectos.editar', async () => {
  const db = montar();
  // Carlos solo tiene `proyectos.ver`: en la capa de acceso, dirigir el proyecto
  // ya da la edición. Un espejo de esta regla en el cliente que exigiera
  // `proyectos.editar` le esconderría el botón a quien sí puede pulsarlo.
  sembrarProyecto(db, {
    id: 'p1',
    responsable: CARLOS.sub,
    miembros: [[CARLOS.sub, 'responsable'], [BEA.sub, 'observador']],
  });

  const suyo = await api('GET', '/api/proyectos/p1', undefined, CARLOS);
  assert.deepEqual(suyo.body.proyecto.permisos_fila, { editar: true, borrar: false });
  // Y la misma respuesta en los dos listados, que es donde se pintan los botones.
  const listado = await api('GET', '/api/proyectos', undefined, CARLOS);
  assert.deepEqual(listado.body.proyectos[0].permisos_fila, { editar: true, borrar: false });
  const mios = await api('GET', '/api/proyectos/mios', undefined, CARLOS);
  assert.deepEqual(mios.body.proyectos[0].permisos_fila, { editar: true, borrar: false });

  // La observadora no edita, aunque tenga `proyectos.editar`; y sí puede borrar,
  // porque eso es exactamente lo que `borrarProyecto` deja hacer a quien tiene
  // `proyectos.borrar` y ve el proyecto.
  const observando = await api('GET', '/api/proyectos/p1', undefined, BEA);
  assert.deepEqual(observando.body.proyecto.permisos_fila, { editar: false, borrar: true });
  assert.equal(
    (await api('PATCH', '/api/proyectos/p1', { nombre: 'Otro' }, BEA)).status,
    403,
    'lo que dice permisos_fila es lo que responde la escritura',
  );
});

test('permisos_fila en el listado no cuesta ninguna lectura extra', async () => {
  const db = montar();
  sembrarProyecto(db, { id: 'p1' });
  sembrarProyecto(db, { id: 'p2', actualizado: '2026-08-05T10:00:00.000Z' });
  await api('GET', '/api/proyectos', undefined, ANA);
  const antes = db.operaciones.length;

  const lista = await api('GET', '/api/proyectos', undefined, ANA);
  assert.equal(lista.body.proyectos.every((p) => p.permisos_fila.editar === true), true);

  // Sale del mapa de pertenencia que el listado ya cargaba para filtrar la
  // visibilidad: el índice de listado, el de pertenencia y sus dos lotes.
  const nuevas = db.operaciones.slice(antes);
  assert.equal(
    nuevas.filter((o) => o.tipo === 'QueryCommand' && o.tabla === tables.proyectos).length,
    2,
    'ni una Query por proyecto para saber qué se puede hacer con él',
  );
  assert.equal(
    nuevas.filter((o) => o.tipo === 'BatchGetCommand').length,
    2,
    'la pertenencia y los nombres; nada por fila',
  );
});

// ─── Historial ───

test('el historial recoge alta, miembros y vínculos, y hereda la visibilidad', async () => {
  const db = montar();
  const alta = await api('POST', '/api/proyectos', { nombre: 'Obra' }, ANA);
  const id = alta.body.proyecto.id_proyecto;
  await api('POST', `/api/proyectos/${id}/miembros`, { usuario_id: BEA.sub }, ANA);
  await api('POST', `/api/proyectos/${id}/vinculos`, { tipo: 'local', id: '3' }, ANA);
  await api('DELETE', `/api/proyectos/${id}/miembros/${BEA.sub}`, undefined, ANA);

  const historial = await api('GET', `/api/proyectos/${id}/actividad`, undefined, ANA);
  assert.equal(historial.status, 200);
  assert.deepEqual(
    historial.body.actividad.map((a) => a.accion),
    ['miembro_quitado', 'vinculo_anadido', 'miembro_anadido', 'creada'],
  );
  assert.equal(historial.body.actividad[0].usuario_id, ANA.sub);
  assert.equal(historial.body.cursor, null);

  const ajeno = await api('GET', `/api/proyectos/${id}/actividad`, undefined, CARLOS);
  assert.equal(ajeno.status, 404);
});
