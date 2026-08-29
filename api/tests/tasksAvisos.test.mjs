/**
 * Aviso por email de tareas que vencen (Fase 1A).
 *
 * Lo que se fija aquí no es que salga un correo, es que salga **el** correo:
 *
 * - **Uno por persona, con su lista.** Quince correos a las nueve de la mañana
 *   se silencian el primer día, y entonces el módulo ya no avisa de nada.
 * - **Solo lo que está abierto y tiene plazo.** Las cerradas no están en el
 *   índice y las que no tienen fecha límite ordenan en `9999-12-31`, fuera del
 *   corte: si alguna de las dos apareciera, el aviso dejaría de creerse.
 * - **A su responsable y a nadie más.**
 * - **El nombre del proyecto solo a quien lo alcanza.** Tener una tarea asignada
 *   no da acceso al proyecto del que cuelga, y el correo no es una puerta lateral
 *   para leer su nombre.
 * - **Una vez al día**, pase lo que pase con el reloj del servidor.
 * - **Desactivado de fábrica**: desplegar esto no manda un solo correo.
 * - **Un buzón que falla no deja a los demás sin aviso.**
 */

import test from 'node:test';
import { strict as assert } from 'node:assert';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.LOG_LEVEL = 'silent';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK, vencimientoOrdenDe, skProyectoDe } = await import('../lib/tasks/tipos.js');
const {
  AVISOS_AJUSTE_PK,
  AVISOS_AJUSTE_SK,
  enviarAvisosVencimiento,
  esHoraDeAvisar,
  HORA_AVISO_POR_DEFECTO,
  leerAjustesAvisos,
} = await import('../lib/tasks/avisos.js');

// ─── Mundo de pruebas ───

const HOY = '2026-08-26';

const ANA = { id_usuario: '000001', Email: 'ana@grupo.test', Nombre: 'Ana Ruiz' };
const BEA = { id_usuario: '000002', Email: 'bea@grupo.test', Nombre: 'Bea Soler' };
/** Sin email: no hay a dónde escribirle. */
const CARLOS = { id_usuario: '000003', Nombre: 'Carlos Gil' };

const OBRA = 'p-obra';

/** Día natural desplazado respecto al día de la tanda. */
function dia(desplazamiento) {
  const [y, m, d] = HOY.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + desplazamiento);
  return fecha.toISOString().slice(0, 10);
}

/**
 * @param {{ ajustes?: object|null, personas?: object[], miembros?: string[] }} [opciones]
 *   `ajustes: null` deja la configuración sin escribir, que es como nace en
 *   producción. `miembros` son los ids que participan en el proyecto: el nombre
 *   del proyecto solo viaja a quien lo alcanza.
 */
function montar({
  ajustes = { Enabled: true, hora: '08:30' },
  personas = [ANA, BEA, CARLOS],
  miembros = [ANA.id_usuario, BEA.id_usuario],
} = {}) {
  const db = crearDynamoMemoria();
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
  db.instalar(docClient);

  // El contexto de acceso se cachea un minuto por usuario: entre pruebas se tira.
  invalidarContextoAcceso();

  for (const persona of personas) db.sembrar(tables.usuarios, persona);
  db.sembrar(tables.proyectos, {
    PK: PK.proyecto(OBRA),
    SK: SK.meta,
    id_proyecto: OBRA,
    nombre: 'Reforma de la barra',
    estado: 'activo',
  });
  for (const id of miembros) {
    db.sembrar(tables.proyectos, {
      PK: PK.proyecto(OBRA),
      SK: SK.miembro(id),
      usuario_id: id,
      rol_proyecto: 'miembro',
    });
  }
  if (ajustes) {
    db.sembrar(tables.ajustes, { PK: AVISOS_AJUSTE_PK, SK: AVISOS_AJUSTE_SK, ...ajustes });
  }
  return db;
}

/** Tarea sembrada con sus claves derivadas, como las escribiría el módulo. */
function sembrarTarea(db, datos) {
  const tarea = { estado: 'pendiente', prioridad: 'media', ...datos };
  const item = { PK: PK.tarea(tarea.id_tarea), SK: SK.meta, ...tarea };
  const vencimiento = vencimientoOrdenDe(tarea);
  if (vencimiento) item.vencimiento_orden = vencimiento;
  const skProyecto = skProyectoDe(tarea);
  if (skProyecto) item.sk_proyecto = skProyecto;
  db.sembrar(tables.tareas, item);
}

/** Buzón de pruebas: recoge los mensajes en vez de mandarlos. */
function buzon({ fallaPara = [] } = {}) {
  const mensajes = [];
  const enviar = async (mensaje) => {
    if (fallaPara.includes(mensaje.to)) throw new Error('550 buzón rechazado');
    mensajes.push(mensaje);
  };
  return { mensajes, enviar, para: (email) => mensajes.filter((m) => m.to === email) };
}

async function lanzar(enviar, opciones = {}) {
  return enviarAvisosVencimiento({ hoy: HOY, enviar, ...opciones });
}

// ─── Un correo por persona ───

test('cada persona recibe un solo email con todas sus tareas, no uno por tarea', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Pedir taburetes',
    responsable_id: ANA.id_usuario,
    proyecto_id: OBRA,
    fecha_limite: dia(-2),
  });
  sembrarTarea(db, {
    id_tarea: 't2',
    titulo: 'Firmar presupuesto',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(0),
  });
  sembrarTarea(db, {
    id_tarea: 't3',
    titulo: 'Llamar al electricista',
    responsable_id: ANA.id_usuario,
    proyecto_id: OBRA,
    fecha_limite: dia(-1),
  });

  const correo = buzon();
  const r = await lanzar(correo.enviar);

  assert.equal(r.ok, true);
  assert.equal(r.enviados, 1);
  assert.equal(r.tareas, 3);
  assert.equal(correo.mensajes.length, 1, 'un correo por persona, no uno por tarea');

  const [mensaje] = correo.mensajes;
  assert.equal(mensaje.to, ANA.Email);
  for (const titulo of ['Pedir taburetes', 'Firmar presupuesto', 'Llamar al electricista']) {
    assert.ok(mensaje.text.includes(titulo), `falta «${titulo}» en el correo`);
  }
  assert.ok(mensaje.text.includes('Reforma de la barra'), 'el correo dice de qué proyecto es la tarea');
  assert.ok(mensaje.text.includes('26/08/2026'), 'las fechas se muestran en formato español');
  assert.match(mensaje.subject, /2 tareas vencidas y 1 vence hoy/);
});

test('el correo no lleva la descripción de la tarea', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Revisar contrato',
    descripcion: 'Ojo con la cláusula de penalización: el gestor dice que no la firmemos',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });

  const correo = buzon();
  await lanzar(correo.enviar);

  const [mensaje] = correo.mensajes;
  assert.ok(mensaje.text.includes('Revisar contrato'));
  assert.equal(mensaje.text.includes('penalización'), false);
  assert.equal(mensaje.html.includes('penalización'), false);
});

test('el correo no dice el nombre de un proyecto que el destinatario no alcanza', async () => {
  // Ana tiene la tarea asignada pero no participa en el proyecto: si abriera la
  // ficha recibiría un 404, así que el correo tampoco puede darle el nombre. El
  // caso real es un proyecto llamado «Despido de J. P.».
  const db = montar({ miembros: [BEA.id_usuario] });
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Preparar la documentación',
    responsable_id: ANA.id_usuario,
    proyecto_id: OBRA,
    fecha_limite: dia(-1),
  });

  const correo = buzon();
  const r = await lanzar(correo.enviar);

  assert.equal(r.enviados, 1);
  const [mensaje] = correo.mensajes;
  assert.ok(mensaje.text.includes('Preparar la documentación'), 'su tarea sí la ve');
  assert.equal(
    mensaje.text.includes('Reforma de la barra'),
    false,
    'lo que no ve es de qué proyecto es',
  );
  assert.equal(mensaje.html.includes('Reforma de la barra'), false);
});

// ─── Qué entra en el aviso ───

test('no se avisa de tareas cerradas ni de las que no tienen fecha límite', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 'abierta',
    titulo: 'Cambiar la carta',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });
  // Cerrada y pasada de plazo: el escritor le borra `vencimiento_orden`, así que
  // ni siquiera está en el índice.
  sembrarTarea(db, {
    id_tarea: 'hecha',
    titulo: 'Vencida pero hecha',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-9),
    estado: 'hecha',
  });
  sembrarTarea(db, {
    id_tarea: 'cancelada',
    titulo: 'Vencida pero cancelada',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-4),
    estado: 'cancelada',
  });
  // Sin plazo: ordena en 9999-12-31 y queda fuera del corte.
  sembrarTarea(db, { id_tarea: 'sinplazo', titulo: 'Repasar proveedores', responsable_id: ANA.id_usuario });
  // Vence pasado mañana: todavía no toca.
  sembrarTarea(db, {
    id_tarea: 'futura',
    titulo: 'Pedir manteles',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(2),
  });

  const correo = buzon();
  const r = await lanzar(correo.enviar);

  assert.equal(r.tareas, 1);
  const [mensaje] = correo.mensajes;
  assert.ok(mensaje.text.includes('Cambiar la carta'));
  for (const titulo of ['Vencida pero hecha', 'Vencida pero cancelada', 'Repasar proveedores', 'Pedir manteles']) {
    assert.equal(mensaje.text.includes(titulo), false, `«${titulo}» no debería avisarse`);
  }
});

test('a cada persona solo se le avisa de sus tareas', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 'de-ana',
    titulo: 'Cerrar el pedido',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });
  sembrarTarea(db, {
    id_tarea: 'de-bea',
    titulo: 'Colocar el rótulo',
    responsable_id: BEA.id_usuario,
    fecha_limite: dia(-3),
  });

  const correo = buzon();
  const r = await lanzar(correo.enviar);

  assert.equal(r.enviados, 2);
  const [aAna] = correo.para(ANA.Email);
  const [aBea] = correo.para(BEA.Email);
  assert.ok(aAna.text.includes('Cerrar el pedido'));
  assert.equal(aAna.text.includes('Colocar el rótulo'), false, 'las tareas de otra persona no salen');
  assert.ok(aBea.text.includes('Colocar el rótulo'));
  assert.equal(aBea.text.includes('Cerrar el pedido'), false);
});

test('el correo dice cuántos días lleva vencida cada tarea', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 'vieja',
    titulo: 'Devolver el material',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-3),
  });
  sembrarTarea(db, {
    id_tarea: 'ayer',
    titulo: 'Mandar las fotos',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });
  sembrarTarea(db, {
    id_tarea: 'hoy',
    titulo: 'Confirmar la entrega',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(0),
  });

  const correo = buzon();
  await lanzar(correo.enviar);

  const [mensaje] = correo.mensajes;
  assert.match(mensaje.text, /Devolver el material.*vencida hace 3 días/);
  assert.match(mensaje.text, /Mandar las fotos.*vencida hace 1 día/, 'un solo día se dice en singular');
  assert.match(mensaje.text, /Confirmar la entrega.*vence hoy/, 'lo que vence hoy todavía no está vencido');
});

test('la tanda no recorre la tabla de tareas: una Query por persona al índice', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Revisar extintores',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });

  const correo = buzon();
  await lanzar(correo.enviar);

  assert.equal(
    db.operaciones.filter((o) => o.tipo === 'ScanCommand' && o.tabla === tables.tareas).length,
    0,
    'ni un Scan de la tabla de tareas',
  );
  assert.equal(
    db.operaciones.filter((o) => o.tipo === 'QueryCommand' && o.tabla === tables.tareas).length,
    3,
    'una Query por persona del maestro (también sin email: la campana lo necesita)',
  );
});

// ─── Idempotencia ───

test('ejecutarlo dos veces el mismo día no manda el aviso dos veces', async () => {
  const db = montar();
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Pintar la sala',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });

  const correo = buzon();
  const primera = await lanzar(correo.enviar);
  assert.equal(primera.enviados, 1);

  const segunda = await lanzar(correo.enviar);
  assert.equal(segunda.enviados, 0);
  assert.equal(segunda.motivo, 'ya_enviado');
  assert.equal(correo.mensajes.length, 1, 'el día ya estaba reclamado');

  // Al día siguiente sí vuelve a avisar.
  const manana = await lanzar(correo.enviar, { hoy: dia(1) });
  assert.equal(manana.enviados, 1);
  assert.equal(correo.mensajes.length, 2);

  const ajustes = db.obtener(tables.ajustes, { PK: AVISOS_AJUSTE_PK, SK: AVISOS_AJUSTE_SK });
  assert.equal(ajustes.ultimo_dia_enviado, dia(1));
  assert.equal(
    db.obtener(tables.ajustes, { PK: AVISOS_AJUSTE_PK, SK: 'avisos_vencimiento_cerrojo' }),
    null,
    'el cerrojo se libera al terminar la tanda',
  );
});

test('la hora decide cuándo sale la tanda, y una vez enviada no se reintenta el resto del día', () => {
  const ajustes = { enabled: true, hora: '08:30', ultimo_dia_enviado: '' };

  // En agosto, las 06:00 UTC son las 08:00 en Madrid: todavía no.
  assert.equal(esHoraDeAvisar(ajustes, new Date('2026-08-26T06:00:00Z')), false);
  assert.equal(esHoraDeAvisar(ajustes, new Date('2026-08-26T06:30:00Z')), true);
  // Pasada la hora sigue valiendo: un reinicio a las 08:30 no deja a nadie sin aviso.
  assert.equal(esHoraDeAvisar(ajustes, new Date('2026-08-26T09:00:00Z')), true);
  assert.equal(
    esHoraDeAvisar({ ...ajustes, ultimo_dia_enviado: '2026-08-26' }, new Date('2026-08-26T09:00:00Z')),
    false,
  );
  assert.equal(esHoraDeAvisar({ ...ajustes, enabled: false }, new Date('2026-08-26T09:00:00Z')), false);
});

// ─── Configuración ───

test('sin configuración escrita el aviso está desactivado y no manda nada', async () => {
  const db = montar({ ajustes: null });
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Montar la terraza',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-5),
  });

  const ajustes = await leerAjustesAvisos();
  assert.equal(ajustes.enabled, false, 'desactivado es el valor por defecto');
  assert.equal(ajustes.hora, HORA_AVISO_POR_DEFECTO);

  const correo = buzon();
  const r = await lanzar(correo.enviar);
  assert.equal(r.motivo, 'desactivado');
  assert.deepEqual(correo.mensajes, []);
  assert.equal(
    db.listar(tables.ajustes).length,
    0,
    'estando desactivado no se escribe nada, ni siquiera el cerrojo',
  );
});

test('desactivado en configuración no manda nada aunque haya tareas vencidas', async () => {
  const db = montar({ ajustes: { Enabled: false, hora: '08:30' } });
  sembrarTarea(db, {
    id_tarea: 't1',
    titulo: 'Instalar cámaras',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-7),
  });

  const correo = buzon();
  const r = await lanzar(correo.enviar);
  assert.equal(r.motivo, 'desactivado');
  assert.deepEqual(correo.mensajes, []);
});

// ─── Tolerancia a fallos ───

test('un usuario sin email no rompe la tanda y un envío que falla no impide los demás', async () => {
  // Bea va antes que Ana en el maestro: si el fallo cortara la tanda, Ana no
  // recibiría nada. Carlos no tiene email: no correo, sí campana.
  const db = montar({ personas: [BEA, ANA, CARLOS] });
  sembrarTarea(db, {
    id_tarea: 'de-bea',
    titulo: 'Cambiar la instalación',
    responsable_id: BEA.id_usuario,
    fecha_limite: dia(-2),
  });
  sembrarTarea(db, {
    id_tarea: 'de-ana',
    titulo: 'Repasar la obra',
    responsable_id: ANA.id_usuario,
    fecha_limite: dia(-1),
  });
  sembrarTarea(db, {
    id_tarea: 'de-carlos',
    titulo: 'Tarea de quien no tiene correo',
    responsable_id: CARLOS.id_usuario,
    fecha_limite: dia(-6),
  });

  const correo = buzon({ fallaPara: [BEA.Email] });
  const r = await lanzar(correo.enviar);

  assert.equal(r.enviados, 1);
  assert.equal(r.fallidos, 1);
  assert.equal(correo.para(ANA.Email).length, 1, 'un buzón rechazado no deja a los demás sin aviso');
  assert.equal(correo.para(BEA.Email).length, 0);
  assert.deepEqual(
    correo.mensajes.map((m) => m.to),
    [ANA.Email],
    'a quien no tiene email no se le escribe, y se salta sin ruido',
  );

  const { listarNotificaciones } = await import('../lib/tasks/notificaciones.js');
  const campanaCarlos = await listarNotificaciones({ usuarioId: CARLOS.id_usuario });
  assert.equal(
    campanaCarlos.notificaciones.filter((n) => n.tipo === 'vencimiento').length,
    1,
    'sin email también recibe la campana de vencimiento',
  );
  assert.ok(r.notificaciones >= 3);
});
