/**
 * Plantillas de proyecto (Fase 4).
 *
 * Fija el contrato: CRUD sobre `PLANTILLA#`, listado por GSI sin Scan,
 * instanciar vía `crearProyecto` + `crearTareasEnLote` (con compensación), y
 * que el POST público de proyectos **no** acepte `plantilla_origen_id`.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-plantillas';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK, GSI_LISTADO } = await import('../lib/tasks/tipos.js');
const { default: proyectosRouter } = await import('../routes/proyectos.js');

const JEFE = { sub: '000001', email: 'jefe@grupo.test', rol: 'Administrador' };
const ANA = { sub: '000007', email: 'ana@grupo.test', rol: 'Jefa de proyectos', Nombre: 'Ana', Apellidos: 'Ruiz' };
/** Ve proyectos pero no gestiona plantillas ni crea. */
const CARLOS = { sub: '000009', email: 'carlos@grupo.test', rol: 'Camarero' };
/** Puede crear proyectos (instanciar) pero no editar plantillas. */
const CREA = { sub: '000011', email: 'crea@grupo.test', rol: 'Creadora' };

const PERMISOS_POR_ROL = {
  'Jefa de proyectos': [
    'proyectos.ver',
    'proyectos.crear',
    'proyectos.editar',
    'proyectos.borrar',
    'proyectos.plantillas',
  ],
  Camarero: ['proyectos.ver'],
  Creadora: ['proyectos.ver', 'proyectos.crear', 'proyectos.borrar'],
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

  for (const u of [JEFE, ANA, CARLOS, CREA]) {
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

  db.instalar(docClient);
  invalidarContextoAcceso();
  return db;
}

const TAREAS_APERTURA = [
  {
    titulo: 'Contratar obra',
    descripcion: 'Presupuestos',
    dias_desde_inicio: 0,
    rol_responsable_sugerido: 'Responsable de obras',
    checklist: ['Pedir 3 ofertas', 'Comparar'],
  },
  {
    titulo: 'Licencia',
    dias_desde_inicio: 14,
    checklist: ['Presentar expediente'],
  },
  { titulo: 'Mobiliario', dias_desde_inicio: 30 },
];

// ─── SK.tareaPlantilla ───

test('SK.tareaPlantilla rellena el orden a 3 dígitos', () => {
  assert.equal(SK.tareaPlantilla(0), 'TAREA#000');
  assert.equal(SK.tareaPlantilla(7), 'TAREA#007');
  assert.equal(SK.tareaPlantilla(49), 'TAREA#049');
});

// ─── Permisos de ruta ───

test('sin proyectos.plantillas no se crea ni edita; sin crear no se instancia', async () => {
  montar();
  assert.equal((await api('POST', '/api/proyectos/plantillas', { nombre: 'X' }, CARLOS)).status, 403);
  assert.equal((await api('GET', '/api/proyectos/plantillas', undefined, CARLOS)).status, 200);

  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Apertura local',
    tareas: [{ titulo: 'Una' }],
  });
  assert.equal(creada.status, 200);
  const id = creada.body.plantilla.id_plantilla;

  assert.equal(
    (await api('PATCH', `/api/proyectos/plantillas/${id}`, { nombre: 'Otro' }, CREA)).status,
    403,
  );
  assert.equal(
    (await api('POST', `/api/proyectos/plantillas/${id}/instanciar`, {}, CARLOS)).status,
    403,
  );
  assert.equal(
    (await api('POST', `/api/proyectos/plantillas/${id}/instanciar`, { nombre: 'Nuevo local' }, CREA))
      .status,
    200,
  );
});

// ─── CRUD ───

test('crear plantilla escribe META + TAREA# y el listado embebe tareas', async () => {
  const db = montar();
  const r = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Apertura local',
    descripcion: 'Checklist de apertura',
    departamento_id: 'dep-obras',
    tareas: TAREAS_APERTURA,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const p = r.body.plantilla;
  assert.ok(p.id_plantilla);
  assert.equal(p.nombre, 'Apertura local');
  assert.equal(p.departamento_id, 'dep-obras');
  assert.equal(p.tareas.length, 3);
  assert.equal(p.tareas[0].orden, 0);
  assert.equal(p.tareas[0].SK, undefined, 'SK no sale al cliente');
  assert.equal(p.tareas[1].dias_desde_inicio, 14);
  assert.equal(p.tareas[0].checklist.length, 2);
  assert.equal(p.tareas[0].rol_responsable_sugerido, 'Responsable de obras');

  const filas = db.listar(tables.proyectos).filter((it) => it.PK === PK.plantilla(p.id_plantilla));
  assert.equal(filas.length, 4); // META + 3 tareas
  const meta = filas.find((it) => it.SK === SK.meta);
  assert.equal(meta.gsi_listado, GSI_LISTADO.plantilla);
  assert.ok(filas.some((it) => it.SK === SK.tareaPlantilla(0)));
  assert.ok(filas.some((it) => it.SK === SK.tareaPlantilla(2)));

  const lista = await api('GET', '/api/proyectos/plantillas');
  assert.equal(lista.status, 200);
  assert.equal(lista.body.plantillas.length, 1);
  assert.equal(lista.body.plantillas[0].tareas.length, 3);
  assert.equal(lista.body.cursor, null);
});

test('PATCH con tareas sustituye el set; DELETE borra la partición', async () => {
  const db = montar();
  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Vieja',
    tareas: TAREAS_APERTURA,
  });
  const id = creada.body.plantilla.id_plantilla;

  const patch = await api('PATCH', `/api/proyectos/plantillas/${id}`, {
    nombre: 'Nueva',
    tareas: [{ titulo: 'Solo una', dias_desde_inicio: 1 }],
  });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.plantilla.nombre, 'Nueva');
  assert.equal(patch.body.plantilla.tareas.length, 1);
  assert.equal(patch.body.plantilla.tareas[0].titulo, 'Solo una');

  const filas = db.listar(tables.proyectos).filter((it) => it.PK === PK.plantilla(id));
  assert.equal(filas.length, 2);
  assert.ok(!filas.some((it) => it.SK === SK.tareaPlantilla(2)));

  const borrado = await api('DELETE', `/api/proyectos/plantillas/${id}`);
  assert.equal(borrado.status, 200);
  assert.equal(db.listar(tables.proyectos).filter((it) => it.PK === PK.plantilla(id)).length, 0);
  assert.equal((await api('DELETE', `/api/proyectos/plantillas/${id}`)).status, 404);
});

test('si falla el Put de tareas en PATCH no se dejan vacías ni se toca META', async () => {
  const db = montar();
  const { actualizarPlantilla } = await import('../lib/tasks/plantillas.js');
  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Original',
    tareas: TAREAS_APERTURA,
  });
  const id = creada.body.plantilla.id_plantilla;

  // Put-first: si el rewrite falla al escribir, deben quedar las tareas viejas
  // y el nombre no debe actualizarse.
  db.interceptar('PutCommand', tables.proyectos, (entrada) => {
    if (typeof entrada?.Item?.SK === 'string' && entrada.Item.SK.startsWith('TAREA#')) {
      throw new Error('fallo simulado al reescribir tareas de plantilla');
    }
  });

  await assert.rejects(
    () =>
      actualizarPlantilla(id, {
        nombre: 'No debe guardarse',
        tareas: [{ titulo: 'Sustituta' }],
      }),
    /fallo simulado al reescribir tareas de plantilla/,
  );

  const filas = db.listar(tables.proyectos).filter((it) => it.PK === PK.plantilla(id));
  const meta = filas.find((it) => it.SK === SK.meta);
  const tareas = filas.filter((it) => typeof it.SK === 'string' && it.SK.startsWith('TAREA#'));
  assert.equal(meta.nombre, 'Original', 'META no se actualiza si falla el rewrite');
  assert.equal(tareas.length, 3, 'las tareas originales siguen ahí');
  assert.ok(tareas.some((t) => t.titulo === 'Contratar obra'));
});

test('no admite más de 50 tareas ni título vacío', async () => {
  montar();
  const demasiadas = Array.from({ length: 51 }, (_, i) => ({ titulo: `T${i}` }));
  const tope = await api('POST', '/api/proyectos/plantillas', { nombre: 'X', tareas: demasiadas });
  assert.equal(tope.status, 400);
  assert.match(tope.body.error, /50/);

  const vacia = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'X',
    tareas: [{ titulo: '  ' }],
  });
  assert.equal(vacia.status, 400);
  assert.match(vacia.body.error, /título/i);
});

// ─── Instanciar ───

test('instanciar crea proyecto con plantilla_origen_id y tareas con fechas', async () => {
  const db = montar();
  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Apertura local',
    departamento_id: 'dep-obras',
    tareas: TAREAS_APERTURA,
  });
  const id = creada.body.plantilla.id_plantilla;

  const r = await api('POST', `/api/proyectos/plantillas/${id}/instanciar`, {
    nombre: 'Bar Nuevo Centro',
    fecha_inicio: '2026-09-01',
    estado: 'activo',
    prioridad: 'alta',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.proyecto.nombre, 'Bar Nuevo Centro');
  assert.equal(r.body.proyecto.plantilla_origen_id, id);
  assert.equal(r.body.proyecto.departamento_id, 'dep-obras');
  assert.equal(r.body.proyecto.fecha_inicio, '2026-09-01');
  assert.equal(r.body.proyecto.estado, 'activo');
  assert.equal(r.body.creadas.length, 3);
  assert.deepEqual(r.body.omitidas, []);

  const porTitulo = Object.fromEntries(r.body.creadas.map((t) => [t.titulo, t]));
  assert.equal(porTitulo['Contratar obra'].fecha_limite, '2026-09-01');
  assert.equal(porTitulo.Licencia.fecha_limite, '2026-09-15');
  assert.equal(porTitulo.Mobiliario.fecha_limite, '2026-10-01');
  assert.equal(porTitulo['Contratar obra'].responsable_id, ANA.sub);
  assert.equal(porTitulo['Contratar obra'].checklist.length, 2);
  assert.ok(porTitulo['Contratar obra'].checklist[0].id);
  assert.equal(porTitulo['Contratar obra'].checklist[0].hecho, false);

  // rol_responsable_sugerido es informativo: no se mapea a usuario.
  assert.equal(porTitulo['Contratar obra'].rol_responsable_sugerido, undefined);

  assert.equal(
    db.listar(tables.tareas).filter((it) => it.SK === 'META').length,
    3,
  );
});

test('POST /proyectos público ignora plantilla_origen_id del body', async () => {
  montar();
  const r = await api('POST', '/api/proyectos', {
    nombre: 'A mano',
    plantilla_origen_id: 'no-debe-guardarse',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.proyecto.plantilla_origen_id, undefined);
});

test('si el lote falla se compensa borrando el proyecto', async () => {
  const db = montar();
  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Con tarea',
    tareas: [{ titulo: 'Ok', dias_desde_inicio: 0 }],
  });
  const id = creada.body.plantilla.id_plantilla;

  // Corromper la tarea en Dynamo: el lote valida y responde 400; hay que
  // compensar el proyecto ya creado.
  db.sembrar(tables.proyectos, {
    PK: PK.plantilla(id),
    SK: SK.tareaPlantilla(0),
    titulo: '',
    orden: 0,
    checklist: [],
  });

  const r = await api('POST', `/api/proyectos/plantillas/${id}/instanciar`, {
    nombre: 'No debe quedar',
    fecha_inicio: '2026-09-01',
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /inválid/i);

  const proyectos = db
    .listar(tables.proyectos)
    .filter((it) => typeof it.PK === 'string' && it.PK.startsWith('PROY#') && it.SK === 'META');
  assert.equal(proyectos.length, 0, 'compensación: borrarProyecto tras fallo de lote');
  assert.equal(db.listar(tables.tareas).length, 0);
});

test('si el lote ok pero incompleto también se compensa', async () => {
  const db = montar();
  const creada = await api('POST', '/api/proyectos/plantillas', {
    nombre: 'Varias',
    tareas: TAREAS_APERTURA,
  });
  const id = creada.body.plantilla.id_plantilla;

  // Simular UnprocessedItems persistentes: `crearTareasEnLote` responde ok con
  // `creadas.length` menor que las esperadas.
  const sendOrig = docClient.send.bind(docClient);
  let sabotearPutsTareas = true;
  docClient.send = async (cmd) => {
    if (
      sabotearPutsTareas &&
      cmd?.constructor?.name === 'BatchWriteCommand' &&
      Array.isArray(cmd.input?.RequestItems?.[tables.tareas]) &&
      cmd.input.RequestItems[tables.tareas].length > 0 &&
      cmd.input.RequestItems[tables.tareas].every((p) => p.PutRequest)
    ) {
      const lista = cmd.input.RequestItems[tables.tareas];
      // Escribir solo la primera una vez; los reintentos del resto quedan sin procesar.
      if (lista.length > 1) {
        await sendOrig({
          constructor: { name: 'BatchWriteCommand' },
          input: { RequestItems: { [tables.tareas]: lista.slice(0, 1) } },
        });
        sabotearPutsTareas = false;
        return { UnprocessedItems: { [tables.tareas]: lista.slice(1) } };
      }
      return { UnprocessedItems: { [tables.tareas]: lista } };
    }
    if (
      !sabotearPutsTareas &&
      cmd?.constructor?.name === 'BatchWriteCommand' &&
      Array.isArray(cmd.input?.RequestItems?.[tables.tareas]) &&
      cmd.input.RequestItems[tables.tareas].every((p) => p.PutRequest)
    ) {
      // Reintentos del resto: seguir sin aceptar.
      return { UnprocessedItems: { [tables.tareas]: cmd.input.RequestItems[tables.tareas] } };
    }
    return sendOrig(cmd);
  };

  try {
    const r = await api('POST', `/api/proyectos/plantillas/${id}/instanciar`, {
      nombre: 'Proyecto a medias',
      fecha_inicio: '2026-09-01',
    });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /todas las tareas/i);

    const proyectos = db
      .listar(tables.proyectos)
      .filter((it) => typeof it.PK === 'string' && it.PK.startsWith('PROY#') && it.SK === 'META');
    assert.equal(proyectos.length, 0, 'compensación tras lote incompleto');
    assert.equal(db.listar(tables.tareas).length, 0);
  } finally {
    docClient.send = sendOrig;
  }
});

test('instanciar plantilla inexistente responde 404', async () => {
  montar();
  const r = await api('POST', '/api/proyectos/plantillas/no-existe/instanciar', {
    nombre: 'X',
  });
  assert.equal(r.status, 404);
});

test('instanciar plantilla sin tareas crea solo el proyecto', async () => {
  montar();
  const creada = await api('POST', '/api/proyectos/plantillas', { nombre: 'Vacía' });
  const r = await api('POST', `/api/proyectos/plantillas/${creada.body.plantilla.id_plantilla}/instanciar`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.proyecto.nombre, 'Vacía');
  assert.equal(r.body.creadas.length, 0);
  assert.equal(r.body.omitidas.length, 0);
});

test('el listado de plantillas no usa Scan', async () => {
  const db = montar();
  await api('POST', '/api/proyectos/plantillas', { nombre: 'A', tareas: [{ titulo: '1' }] });
  await api('POST', '/api/proyectos/plantillas', { nombre: 'B', tareas: [{ titulo: '2' }] });
  const antes = db.operaciones.length;
  const r = await api('GET', '/api/proyectos/plantillas');
  assert.equal(r.status, 200);
  assert.equal(r.body.plantillas.length, 2);
  const nuevas = db.operaciones.slice(antes);
  assert.ok(nuevas.some((o) => o.tipo === 'QueryCommand'));
  assert.ok(!nuevas.some((o) => o.tipo === 'ScanCommand'));
});
