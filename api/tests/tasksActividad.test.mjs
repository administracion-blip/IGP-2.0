/**
 * Registro de actividad del módulo de dirección, y el soporte de índices
 * secundarios y escritura por lotes que se añadió al doble de DynamoDB para poder
 * probar la Fase 1A.
 *
 * Lo que se fija aquí:
 *
 * - Una entrada de historial **nunca queda sin autor**: lo que no dispara una
 *   persona se firma como sistema, de forma explícita.
 * - Aprobar o rechazar una compra **exige importe**. Una traza de aprobación sin
 *   cuánto se aprobó no sirve para auditar nada.
 * - Un fallo de DynamoDB al registrar **no propaga**: perder una línea de historial
 *   no puede tumbar la operación que el usuario ya ha completado con éxito.
 * - Dos acciones en el mismo milisegundo no se pisan.
 * - Los índices dispersos del doble se comportan como los de verdad: un ítem sin el
 *   atributo de clave del índice **no está** en el índice. Es lo que hace que la
 *   vista personal no vea tareas cerradas.
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const {
  ACCIONES,
  AUTOR_SISTEMA,
  construirEntradaActividad,
  listarActividad,
  pkActividad,
  registrarActividad,
  registrarActividadLote,
} = await import('../lib/tasks/actividad.js');

const ANA = { id_usuario: '000007', Nombre: 'Ana Ruiz' };

function montar({ paginaTam = 0 } = {}) {
  const memoria = crearDynamoMemoria({ paginaTam });
  memoria.crearTabla(tables.actividad, { hashKey: 'PK', rangeKey: 'SK' });
  memoria.instalar(docClient);
  return memoria;
}

// ─── Construcción de la entrada ───

test('construirEntradaActividad: clave y campos mínimos', () => {
  const item = construirEntradaActividad({
    tipo: 'proyecto',
    entidadId: 'p1',
    accion: ACCIONES.creada,
    usuario: ANA,
    detalle: { nombre: 'Reforma barra' },
  });
  assert.equal(item.PK, 'PROY#p1');
  assert.match(item.SK, /^ACT#\d{4}-\d{2}-\d{2}T.+#[0-9a-f-]{36}$/);
  assert.equal(item.accion, 'creada');
  assert.equal(item.usuario_id, '000007');
  assert.equal(item.usuario_nombre, 'Ana Ruiz');
  assert.equal(item.detalle, '{"nombre":"Reforma barra"}');
  assert.ok(item.creado_en);
});

test('construirEntradaActividad: sin autor queda firmada por el sistema', () => {
  for (const usuario of [undefined, null, {}, { id_usuario: '  ' }]) {
    const item = construirEntradaActividad({
      tipo: 'tarea',
      entidadId: 't1',
      accion: ACCIONES.estadoCambiado,
      usuario,
    });
    assert.equal(item.usuario_id, AUTOR_SISTEMA);
  }
});

test('construirEntradaActividad: acepta el usuario del token (sub)', () => {
  const item = construirEntradaActividad({
    tipo: 'tarea',
    entidadId: 't1',
    accion: ACCIONES.creada,
    usuario: { sub: '000003', nombre: 'Bea' },
  });
  assert.equal(item.usuario_id, '000003');
  assert.equal(item.usuario_nombre, 'Bea');
});

test('construirEntradaActividad: aprobar o rechazar una compra exige importe', () => {
  for (const accion of [ACCIONES.compraAprobada, ACCIONES.compraRechazada]) {
    assert.throws(
      () => construirEntradaActividad({ tipo: 'compra', entidadId: 'l1', accion, usuario: ANA }),
      /exige un importe/,
      accion,
    );
    // Un importe no numérico tampoco vale: dejaría la traza igual de inútil.
    assert.throws(
      () =>
        construirEntradaActividad({ tipo: 'compra', entidadId: 'l1', accion, usuario: ANA, importe: 'mucho' }),
      /exige un importe/,
    );
    const ok = construirEntradaActividad({ tipo: 'compra', entidadId: 'l1', accion, usuario: ANA, importe: 0 });
    assert.equal(ok.importe, 0);
  }
});

test('construirEntradaActividad: el resto de acciones no necesitan importe', () => {
  const item = construirEntradaActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.editada });
  assert.equal('importe' in item, false);
});

test('construirEntradaActividad: tipo o acción inválidos lanzan', () => {
  assert.throws(() => construirEntradaActividad({ tipo: 'factura', entidadId: 'f1', accion: 'creada' }), /no válido/);
  assert.throws(() => construirEntradaActividad({ tipo: 'proyecto', entidadId: '', accion: 'creada' }), /id de la entidad/);
  assert.throws(() => construirEntradaActividad({ tipo: 'proyecto', entidadId: 'p1', accion: '  ' }), /una acción/);
});

test('construirEntradaActividad: un detalle enorme se recorta en lugar de romper la escritura', () => {
  const item = construirEntradaActividad({
    tipo: 'proyecto',
    entidadId: 'p1',
    accion: ACCIONES.editada,
    detalle: { texto: 'x'.repeat(20000) },
  });
  assert.ok(item.detalle.length < 20000);
  assert.ok(item.detalle.endsWith('…[recortado]'));
});

test('pkActividad: un prefijo por tipo de entidad', () => {
  assert.equal(pkActividad('proyecto', 'p1'), 'PROY#p1');
  assert.equal(pkActividad('tarea', 't1'), 'TAREA#t1');
  assert.equal(pkActividad('compra', 'l1'), 'COMPRA#l1');
  assert.equal(pkActividad('reunion', 'r1'), 'REU#r1');
});

// ─── Escritura y lectura ───

test('registrarActividad: escribe y se lee más reciente primero', async () => {
  montar();
  await registrarActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.creada, usuario: ANA });
  await registrarActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.editada, usuario: ANA });
  await registrarActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.miembroAnadido, usuario: ANA });

  const { actividad, cursor } = await listarActividad({ tipo: 'proyecto', entidadId: 'p1' });
  assert.deepEqual(
    actividad.map((a) => a.accion),
    ['miembro_anadido', 'editada', 'creada'],
  );
  assert.equal(cursor, null);
  // Las claves de DynamoDB no se filtran al cliente.
  assert.equal('PK' in actividad[0], false);
  assert.equal('SK' in actividad[0], false);
});

test('registrarActividad: el historial de cada entidad está aislado', async () => {
  montar();
  await registrarActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.creada });
  await registrarActividad({ tipo: 'tarea', entidadId: 'p1', accion: ACCIONES.creada });

  const proyecto = await listarActividad({ tipo: 'proyecto', entidadId: 'p1' });
  const tarea = await listarActividad({ tipo: 'tarea', entidadId: 'p1' });
  assert.equal(proyecto.actividad.length, 1);
  assert.equal(tarea.actividad.length, 1);
});

test('registrarActividad: con el reloj clavado no se pisan y conservan el orden', async () => {
  // Es el caso real de un lote o de un handler que registra dos acciones seguidas:
  // `Date.now()` devuelve el mismo milisegundo para todas.
  const memoria = montar();
  const now = Date.now;
  Date.now = () => 1787824800000;
  try {
    await registrarActividad({ tipo: 'tarea', entidadId: 't1', accion: ACCIONES.estadoCambiado });
    await registrarActividad({ tipo: 'tarea', entidadId: 't1', accion: ACCIONES.reasignada });
    await registrarActividad({ tipo: 'tarea', entidadId: 't1', accion: ACCIONES.comentario });
  } finally {
    Date.now = now;
  }

  assert.equal(memoria.listar(tables.actividad).length, 3);
  const { actividad } = await listarActividad({ tipo: 'tarea', entidadId: 't1' });
  assert.deepEqual(
    actividad.map((a) => a.accion),
    ['comentario', 'reasignada', 'estado_cambiado'],
  );
});

test('registrarActividad: un fallo de DynamoDB no propaga', async () => {
  const memoria = montar();
  memoria.interceptar('PutCommand', tables.actividad, () => {
    throw new Error('throttling');
  });
  const res = await registrarActividad({ tipo: 'proyecto', entidadId: 'p1', accion: ACCIONES.creada });
  assert.equal(res, null);
});

test('registrarActividad: un error de programación sí lanza', async () => {
  montar();
  await assert.rejects(
    registrarActividad({ tipo: 'inventado', entidadId: 'x', accion: ACCIONES.creada }),
    /no válido/,
  );
});

test('listarActividad: pagina con cursor opaco', async () => {
  montar({ paginaTam: 2 });
  for (let i = 0; i < 5; i += 1) {
    await registrarActividad({ tipo: 'tarea', entidadId: 't1', accion: `paso_${i}` });
  }

  const primera = await listarActividad({ tipo: 'tarea', entidadId: 't1' });
  assert.equal(primera.actividad.length, 2);
  assert.ok(primera.cursor);

  const segunda = await listarActividad({ tipo: 'tarea', entidadId: 't1', cursor: primera.cursor });
  assert.equal(segunda.actividad.length, 2);
  // Sin solaparse con la primera página.
  const vistas = new Set([...primera.actividad, ...segunda.actividad].map((a) => a.accion));
  assert.equal(vistas.size, 4);
});

test('listarActividad: un cursor manipulado empieza por el principio, no revienta', async () => {
  montar();
  await registrarActividad({ tipo: 'tarea', entidadId: 't1', accion: ACCIONES.creada });
  const { actividad } = await listarActividad({ tipo: 'tarea', entidadId: 't1', cursor: 'no-es-base64-válido' });
  assert.equal(actividad.length, 1);
});

// ─── Lote ───

test('registrarActividadLote: escribe todas y valida antes de mandar nada', async () => {
  const memoria = montar();
  await registrarActividadLote([
    { tipo: 'tarea', entidadId: 't1', accion: ACCIONES.creada, usuario: ANA },
    { tipo: 'tarea', entidadId: 't2', accion: ACCIONES.creada, usuario: ANA },
    { tipo: 'tarea', entidadId: 't3', accion: ACCIONES.creada, usuario: ANA },
  ]);
  assert.equal(memoria.listar(tables.actividad).length, 3);
  assert.equal(memoria.operaciones.filter((o) => o.tipo === 'BatchWriteCommand').length, 1);
});

test('registrarActividadLote: si una entrada es inválida no se escribe ninguna', async () => {
  const memoria = montar();
  await assert.rejects(
    registrarActividadLote([
      { tipo: 'tarea', entidadId: 't1', accion: ACCIONES.creada },
      { tipo: 'tarea', entidadId: 't2', accion: '' },
    ]),
    /una acción/,
  );
  assert.equal(memoria.listar(tables.actividad).length, 0);
});

test('registrarActividadLote: más de 25 entradas se parten en varios lotes', async () => {
  const memoria = montar();
  const entradas = Array.from({ length: 60 }, (_, i) => ({
    tipo: 'tarea',
    entidadId: `t${i}`,
    accion: ACCIONES.creada,
  }));
  await registrarActividadLote(entradas);
  assert.equal(memoria.listar(tables.actividad).length, 60);
  assert.equal(memoria.operaciones.filter((o) => o.tipo === 'BatchWriteCommand').length, 3);
});

test('registrarActividadLote: lista vacía no manda nada', async () => {
  const memoria = montar();
  assert.deepEqual(await registrarActividadLote([]), []);
  assert.deepEqual(await registrarActividadLote(undefined), []);
  assert.equal(memoria.operaciones.length, 0);
});

// ─── El doble: índices secundarios ───

test('doble: una Query por índice ordena por su clave de ordenación', async () => {
  const memoria = crearDynamoMemoria();
  memoria.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' } },
  });
  memoria.instalar(docClient);
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  memoria.sembrar(tables.tareas, { PK: 'TAREA#3', SK: 'META', responsable_id: ANA.id_usuario, vencimiento_orden: '2026-09-10#3' });
  memoria.sembrar(tables.tareas, { PK: 'TAREA#1', SK: 'META', responsable_id: ANA.id_usuario, vencimiento_orden: '2026-08-01#1' });
  memoria.sembrar(tables.tareas, { PK: 'TAREA#2', SK: 'META', responsable_id: ANA.id_usuario, vencimiento_orden: '2026-08-20#2' });

  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: 'Responsable-Vencimiento-index',
      KeyConditionExpression: 'responsable_id = :r',
      ExpressionAttributeValues: { ':r': ANA.id_usuario },
    }),
  );
  assert.deepEqual(res.Items.map((i) => i.PK), ['TAREA#1', 'TAREA#2', 'TAREA#3']);
});

test('doble: el índice es disperso — sin el atributo de clave, el ítem no está', async () => {
  const memoria = crearDynamoMemoria();
  memoria.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Responsable-Vencimiento-index': { hashKey: 'responsable_id', rangeKey: 'vencimiento_orden' } },
  });
  memoria.instalar(docClient);
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  // Abierta: está en el índice.
  memoria.sembrar(tables.tareas, { PK: 'TAREA#1', SK: 'META', responsable_id: ANA.id_usuario, vencimiento_orden: '2026-08-01#1', estado: 'pendiente' });
  // Cerrada: el escritor borra `vencimiento_orden`, así que sale del índice.
  memoria.sembrar(tables.tareas, { PK: 'TAREA#2', SK: 'META', responsable_id: ANA.id_usuario, estado: 'hecha' });
  // Fila hija de la misma tarea: nunca llevó el atributo.
  memoria.sembrar(tables.tareas, { PK: 'TAREA#1', SK: 'COMENT#2026-08-01#a', texto: 'hola' });

  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: 'Responsable-Vencimiento-index',
      KeyConditionExpression: 'responsable_id = :r',
      ExpressionAttributeValues: { ':r': ANA.id_usuario },
    }),
  );
  assert.deepEqual(res.Items.map((i) => i.PK), ['TAREA#1']);
});

test('doble: proyección KEYS_ONLY devuelve solo claves de tabla e índice', async () => {
  const memoria = crearDynamoMemoria();
  memoria.crearTabla(tables.tareas, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Vinculo-index': { hashKey: 'vinculo_clave', rangeKey: 'PK', proyeccion: 'KEYS_ONLY' } },
  });
  memoria.instalar(docClient);
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  memoria.sembrar(tables.tareas, {
    PK: 'TAREA#1',
    SK: 'VINC#proveedor#77',
    vinculo_clave: 'proveedor#77',
    etiqueta: 'Distribuciones Sur',
  });

  const res = await docClient.send(
    new QueryCommand({
      TableName: tables.tareas,
      IndexName: 'Vinculo-index',
      KeyConditionExpression: 'vinculo_clave = :v',
      ExpressionAttributeValues: { ':v': 'proveedor#77' },
    }),
  );
  assert.deepEqual(res.Items, [{ PK: 'TAREA#1', SK: 'VINC#proveedor#77', vinculo_clave: 'proveedor#77' }]);
});

test('doble: paginar por índice devuelve un cursor que incluye las claves de la tabla', async () => {
  const memoria = crearDynamoMemoria({ paginaTam: 1 });
  memoria.crearTabla(tables.proyectos, {
    hashKey: 'PK',
    rangeKey: 'SK',
    indices: { 'Listado-index': { hashKey: 'gsi_listado', rangeKey: 'actualizado_en' } },
  });
  memoria.instalar(docClient);
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  memoria.sembrar(tables.proyectos, { PK: 'PROY#a', SK: 'META', gsi_listado: 'PROY', actualizado_en: '2026-08-01' });
  memoria.sembrar(tables.proyectos, { PK: 'PROY#b', SK: 'META', gsi_listado: 'PROY', actualizado_en: '2026-08-02' });

  const consulta = (desde) =>
    docClient.send(
      new QueryCommand({
        TableName: tables.proyectos,
        IndexName: 'Listado-index',
        KeyConditionExpression: 'gsi_listado = :g',
        ExpressionAttributeValues: { ':g': 'PROY' },
        ...(desde && { ExclusiveStartKey: desde }),
      }),
    );

  const primera = await consulta();
  assert.deepEqual(primera.Items.map((i) => i.PK), ['PROY#a']);
  assert.deepEqual(Object.keys(primera.LastEvaluatedKey).sort(), ['PK', 'SK', 'actualizado_en', 'gsi_listado']);

  const segunda = await consulta(primera.LastEvaluatedKey);
  assert.deepEqual(segunda.Items.map((i) => i.PK), ['PROY#b']);
});

test('doble: consultar un índice no declarado avisa de cómo declararlo', async () => {
  const memoria = crearDynamoMemoria();
  memoria.crearTabla(tables.proyectos, { hashKey: 'PK', rangeKey: 'SK' });
  memoria.instalar(docClient);
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

  await assert.rejects(
    docClient.send(
      new QueryCommand({
        TableName: tables.proyectos,
        IndexName: 'Miembro-index',
        KeyConditionExpression: 'usuario_id = :u',
        ExpressionAttributeValues: { ':u': '000007' },
      }),
    ),
    /Índice no creado en el doble: Miembro-index/,
  );
});
