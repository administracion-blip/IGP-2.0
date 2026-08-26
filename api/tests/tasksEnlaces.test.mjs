/**
 * Enlaces externos con captura en servidor (Fase 1A).
 *
 * Lo que se fija aquí es la protección contra SSRF, que es la razón de ser del
 * fichero. La prueba que justifica todo el encargo es la de la **redirección**:
 * una URL pública que redirige a `169.254.169.254` se cuela entera si solo se
 * valida la primera dirección, y con ella se van las credenciales de la
 * instancia.
 *
 * Nada de esto sale a la red: se inyectan el transporte HTTP, la resolución de
 * DNS y el almacén de imágenes.
 */

import test, { after } from 'node:test';
import { strict as assert } from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import express from 'express';

process.env.AWS_REGION = process.env.AWS_REGION || 'eu-west-3';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-las-pruebas-de-enlaces';

const { docClient, tables } = await import('../lib/db.js');
const { crearDynamoMemoria } = await import('./dynamoMemoria.mjs');
const { invalidarContextoAcceso } = await import('../lib/tasks/acceso.js');
const { PK, SK } = await import('../lib/tasks/tipos.js');
const {
  configurarTransporteEnlaces,
  esDireccionPrivada,
  esperarCapturasPendientes,
  extraerMetadatos,
  parametrosSubidaImagen,
  precioDeTexto,
  validarUrlEnlace,
} = await import('../lib/tasks/enlaces.js');
const { default: tareasRouter } = await import('../routes/tareas.js');

// ─── Personas ───

const ANA = { sub: '000001', email: 'ana@grupo.test', rol: 'Direccion' };
/** Con `proyectos.ver` pero sin ser responsable de la tarea: sirve para el 404 de visibilidad. */
const BEA = { sub: '000002', email: 'bea@grupo.test', rol: 'Direccion' };
/** Sin ningún permiso del módulo: no ve la tarea y por tanto tampoco sus enlaces. */
const CARLOS = { sub: '000003', email: 'carlos@grupo.test', rol: 'Camarero' };

const PERMISOS_POR_ROL = {
  Direccion: ['proyectos.ver', 'proyectos.editar', 'proyectos.borrar'],
  Camarero: [],
};

const TAREA = 't-obra';

// ─── Servidor ───

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

let restaurarTransporte = null;

after(() => {
  restaurarTransporte?.();
  servidor?.closeAllConnections?.();
  servidor?.close();
});

// ─── Web de mentira ───

const IMAGEN_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const IMAGEN_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

/**
 * @typedef {{ status?: number, headers?: object, body?: any }} RespuestaFalsa
 */

function montar({ web = {}, dns = {}, ajustes = null } = {}) {
  const db = crearDynamoMemoria();
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
  db.crearTabla(tables.ajustes, { hashKey: 'PK', rangeKey: 'SK' });
  db.crearTabla(tables.usuarios, { hashKey: 'id_usuario' });
  db.crearTabla(tables.rolesPermisos, { hashKey: 'PK', rangeKey: 'SK' });
  db.instalar(docClient);
  invalidarContextoAcceso();

  for (const persona of [ANA, BEA, CARLOS]) {
    db.sembrar(tables.usuarios, {
      id_usuario: persona.sub,
      Email: persona.email,
      Nombre: persona.email,
      Rol: persona.rol,
    });
  }
  for (const [rol, codigos] of Object.entries(PERMISOS_POR_ROL)) {
    for (const codigo of codigos) {
      db.sembrar(tables.rolesPermisos, { PK: `ROL#${rol}`, SK: `PERMISO#${codigo}` });
    }
  }
  if (ajustes) db.sembrar(tables.ajustes, { PK: 'proyectos', SK: 'enlaces', ...ajustes });

  // Tarea suelta de Ana: sin proyecto, para que el acceso dependa solo de ser
  // su responsable y las pruebas no arrastren la ACL de proyecto.
  db.sembrar(tables.tareas, {
    PK: PK.tarea(TAREA),
    SK: SK.meta,
    id_tarea: TAREA,
    titulo: 'Comprar taburetes',
    estado: 'pendiente',
    prioridad: 'media',
    responsable_id: ANA.sub,
    creado_por: ANA.sub,
    creado_en: '2026-08-01T10:00:00.000Z',
    actualizado_en: '2026-08-01T10:00:00.000Z',
    vencimiento_orden: `9999-12-31#${TAREA}`,
  });

  const espia = { peticiones: [], subidas: [], borrados: [], resoluciones: [], firmadasLectura: [] };

  restaurarTransporte?.();
  restaurarTransporte = configurarTransporteEnlaces({
    resolverDns: async (host) => {
      espia.resoluciones.push(host);
      if (net.isIP(host)) return [host];
      const asignada = dns[host];
      if (asignada === undefined) return ['93.184.216.34'];
      if (asignada === null) throw new Error('NXDOMAIN');
      return Array.isArray(asignada) ? asignada : [asignada];
    },
    fetch: async (href) => {
      espia.peticiones.push(href);
      const definicion = web[href];
      if (definicion === undefined) return new Response('no existe', { status: 404 });
      if (typeof definicion === 'function') return definicion();
      if (definicion instanceof Error) throw definicion;
      const { status = 200, headers = {}, body = '' } = definicion;
      return new Response(status === 204 || status === 304 ? null : body, { status, headers });
    },
    subirImagen: async ({ key, cuerpo, contentType }) => {
      espia.subidas.push({ key, bytes: cuerpo.length, contentType });
    },
    urlLectura: async ({ key }) => {
      espia.firmadasLectura.push(key);
      return `https://bucket.test/${key}?firma=lectura`;
    },
    borrarImagen: async ({ key }) => {
      espia.borrados.push(key);
    },
  });

  return { db, espia };
}

function enlacesDe(db) {
  return db.listar(tables.tareas).filter((it) => String(it.SK).startsWith('ENLACE#'));
}

async function anadir(url, usuario = ANA) {
  return api('POST', `/api/tareas/${TAREA}/enlaces`, { url }, usuario);
}

/** Añade el enlace y espera a que la captura de segundo plano termine. */
async function anadirYEsperar(url) {
  const r = await anadir(url);
  await esperarCapturasPendientes();
  return r;
}

const HTML_FICHA = `<!doctype html><html><head>
  <title>Taburete alto de roble</title>
  <meta property="og:image" content="/media/taburete.png">
  <meta property="og:price:amount" content="1.234,50">
  <meta property="og:price:currency" content="EUR">
</head><body>relleno</body></html>`;

// ─── Esquemas ───

test('un esquema que no es http o https se rechaza con 400 y no crea enlace', async () => {
  const { db, espia } = montar();

  for (const url of [
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'gopher://interno.local:70/_conecta',
    'ftp://interno.local/secreto.txt',
  ]) {
    const r = await anadir(url);
    assert.equal(r.status, 400, url);
    assert.match(r.body.error, /http/);
  }

  assert.deepEqual(enlacesDe(db), [], 'un esquema rechazado no debe dejar fila');
  assert.deepEqual(espia.peticiones, [], 'ni una sola petición de salida');
});

test('la configuración puede recortar los esquemas pero nunca añadir file:', async () => {
  const { espia } = montar({ ajustes: { esquemas_permitidos: ['file', 'https'] } });

  const prohibido = await anadir('file:///etc/passwd');
  assert.equal(prohibido.status, 400, 'file: sigue prohibido aunque esté en la configuración');

  const recortado = await anadir('http://publica.test/producto');
  assert.equal(recortado.status, 400, 'la configuración sí puede dejar solo https');
  assert.deepEqual(espia.peticiones, []);
});

// ─── Direcciones privadas ───

test('esDireccionPrivada cubre los rangos internos y sus disfraces en IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    // IPv4 compatible: `http://[::169.254.169.254]/` llega al mismo sitio que la
    // forma mapeada, y el fichero declara que lo desconocido cuenta como privado.
    '::169.254.169.254',
    '::10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '2002:a00:1::',
    'no-es-una-ip',
    '',
  ]) {
    assert.equal(esDireccionPrivada(ip), true, `debería ser privada: ${ip}`);
  }

  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:93.184.216.34']) {
    assert.equal(esDireccionPrivada(ip), false, `debería ser pública: ${ip}`);
  }
});

test('una URL que resuelve a una dirección privada deja el enlace en fallida sin conectar', async () => {
  const { db, espia } = montar({ dns: { 'interno.ejemplo.com': '10.0.0.5' } });

  const r = await anadirYEsperar('http://interno.ejemplo.com/panel');
  assert.equal(r.status, 200, 'el endpoint responde bien: el fallo es de la captura, no suyo');

  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /interna/);
  assert.deepEqual(espia.peticiones, [], 'no se llega a abrir la conexión');
});

test('un dominio que no resuelve deja el enlace en fallida con su motivo', async () => {
  const { db } = montar({ dns: { 'no-existe.test': null } });

  await anadirYEsperar('https://no-existe.test/x');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /resolver/);
});

// ─── Redirecciones: la prueba que justifica el encargo ───

test('una redirección a una dirección privada se rechaza aunque la URL inicial sea pública', async () => {
  const metadatos = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
  const { db, espia } = montar({
    dns: { 'publica.test': '93.184.216.34' },
    web: {
      'http://publica.test/producto': { status: 302, headers: { location: metadatos } },
      [metadatos]: { status: 200, body: '{"SecretAccessKey":"no-deberia-leerse"}' },
    },
  });

  const r = await anadirYEsperar('http://publica.test/producto');
  assert.equal(r.status, 200);

  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /interna/);
  assert.deepEqual(
    espia.peticiones,
    ['http://publica.test/producto'],
    'la segunda petición no debe llegar a hacerse: ahí están las credenciales de la instancia',
  );
});

test('una redirección a otro esquema tampoco se sigue', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/salta': { status: 301, headers: { location: 'file:///etc/passwd' } },
    },
  });

  await anadirYEsperar('http://publica.test/salta');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /http/);
  assert.equal(espia.peticiones.length, 1);
});

test('más de dos redirecciones se rechaza', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/1': { status: 302, headers: { location: 'http://publica.test/2' } },
      'http://publica.test/2': { status: 302, headers: { location: 'http://publica.test/3' } },
      'http://publica.test/3': { status: 302, headers: { location: 'http://publica.test/4' } },
      'http://publica.test/4': { status: 200, body: HTML_FICHA },
    },
  });

  await anadirYEsperar('http://publica.test/1');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /redirecciones/);
  assert.equal(espia.peticiones.length, 3, 'la inicial y dos saltos, ni uno más');
});

test('dos redirecciones sí se siguen', async () => {
  const { db } = montar({
    web: {
      'http://publica.test/1': { status: 302, headers: { location: '/2' } },
      'http://publica.test/2': { status: 302, headers: { location: '/3' } },
      'http://publica.test/3': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
      'http://publica.test/media/taburete.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: IMAGEN_PNG,
      },
    },
  });

  await anadirYEsperar('http://publica.test/1');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'ok');
  assert.equal(enlace.titulo, 'Taburete alto de roble');
});

// ─── Tamaño del cuerpo ───

test('un cuerpo enorme no se descarga entero: se leen los primeros KB y se corta', async () => {
  const estado = { emitidos: 0, cancelado: false };
  const TROZO = 512;
  const { db } = montar({
    ajustes: { max_bytes: 2048 },
    web: {
      'http://publica.test/gigante': () =>
        new Response(
          new ReadableStream({
            pull(controlador) {
              if (estado.emitidos >= 8 * 1024 * 1024) {
                controlador.close();
                return;
              }
              controlador.enqueue(new Uint8Array(TROZO));
              estado.emitidos += TROZO;
            },
            cancel() {
              estado.cancelado = true;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
    },
  });

  await anadirYEsperar('http://publica.test/gigante');

  assert.equal(enlacesDe(db)[0].captura_estado, 'ok');
  assert.ok(
    estado.emitidos <= 2048 + TROZO,
    `se han descargado ${estado.emitidos} bytes de un cuerpo de 8 MB: el flujo no se está cortando`,
  );
  assert.equal(estado.cancelado, true, 'el flujo tiene que cancelarse, no quedarse leyendo de fondo');
});

// ─── Imagen ───

test('un Content-Type image/png cuyos bytes no son una imagen no llega a S3', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/producto': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
      'http://publica.test/media/taburete.png': {
        status: 200,
        // El tipo lo declara quien sirve el fichero: es dato del atacante.
        headers: { 'content-type': 'image/png' },
        body: '<html><script>no soy un png</script></html>',
      },
    },
  });

  await anadirYEsperar('http://publica.test/producto');

  assert.deepEqual(espia.subidas, [], 'nada que no sea una imagen de verdad debe subirse al bucket');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'ok', 'que falle la imagen no invalida título y precio');
  assert.equal(enlace.imagen_s3_key, undefined);
});

test('la imagen del destino se guarda en S3 bajo la clave de la tarea, no se enlaza la original', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/producto': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
      'http://publica.test/media/taburete.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: IMAGEN_PNG,
      },
    },
  });

  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);

  assert.equal(enlace.captura_estado, 'ok');
  assert.equal(enlace.titulo, 'Taburete alto de roble');
  assert.equal(enlace.precio, 1234.5);
  assert.equal(enlace.moneda, 'EUR');
  assert.equal(enlace.imagen_s3_key, `tasks/tareas/${TAREA}/enlaces/${enlace.id_enlace}.png`);
  assert.equal(espia.subidas.length, 1);
  assert.equal(espia.subidas[0].contentType, 'image/png');
  assert.ok(enlace.capturado_en);
});

test('una imagen que apunta a la red interna no se descarga', async () => {
  const html = '<html><head><title>Ficha</title><meta property="og:image" content="http://10.0.0.5/logo.png"></head></html>';
  const { db, espia } = montar({
    web: { 'http://publica.test/producto': { status: 200, body: html, headers: { 'content-type': 'text/html' } } },
  });

  await anadirYEsperar('http://publica.test/producto');
  assert.deepEqual(espia.subidas, []);
  assert.equal(enlacesDe(db)[0].captura_estado, 'ok');
  assert.ok(!espia.peticiones.includes('http://10.0.0.5/logo.png'));
});

// ─── Fallos del destino ───

test('un fallo de la web remota deja el enlace en fallida y la respuesta del endpoint sigue siendo correcta', async () => {
  const { db } = montar({
    web: { 'http://publica.test/caida': { status: 503, body: 'servicio no disponible' } },
  });

  const r = await anadir('http://publica.test/caida');
  assert.equal(r.status, 200);
  assert.equal(r.body.enlace.captura_estado, 'pendiente', 'la respuesta no espera a la captura');
  assert.ok(r.body.enlace.id_enlace);

  await esperarCapturasPendientes();
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.captura_estado, 'fallida');
  assert.match(enlace.captura_error, /503/);

  const detalle = await api('GET', `/api/tareas/${TAREA}`);
  assert.equal(detalle.status, 200, 'la tarea sigue viva');
  assert.equal(detalle.body.tarea.enlaces.length, 1);
});

test('una conexión que revienta deja el enlace en fallida, no un 500', async () => {
  const { db } = montar({
    web: { 'http://publica.test/rota': new Error('ECONNRESET') },
  });

  const r = await anadirYEsperar('http://publica.test/rota');
  assert.equal(r.status, 200);
  assert.equal(enlacesDe(db)[0].captura_estado, 'fallida');
});

// ─── Recaptura ───

test('la recaptura no ocurre sola: solo por su endpoint', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/producto': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
      'http://publica.test/media/taburete.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: IMAGEN_PNG,
      },
    },
  });

  await anadirYEsperar('http://publica.test/producto');
  const peticionesTrasCrear = espia.peticiones.length;
  const [enlace] = enlacesDe(db);

  // Leer la tarea —una y otra vez— no debe volver a salir a la web: los datos
  // capturados son la foto de un momento.
  for (let i = 0; i < 3; i += 1) {
    const detalle = await api('GET', `/api/tareas/${TAREA}`);
    assert.equal(detalle.status, 200);
  }
  const listado = await api('GET', `/api/tareas?responsable=${ANA.sub}`);
  assert.equal(listado.status, 200);
  await esperarCapturasPendientes();
  assert.equal(espia.peticiones.length, peticionesTrasCrear, 'leer la tarea no puede disparar una captura');

  const recaptura = await api('POST', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/recapturar`);
  assert.equal(recaptura.status, 200);
  assert.equal(recaptura.body.enlace.captura_estado, 'ok', 'la recaptura sí espera al resultado');
  assert.ok(espia.peticiones.length > peticionesTrasCrear);
});

test('una recaptura con éxito borra el error de la vez anterior', async () => {
  const { db } = montar({
    web: { 'http://publica.test/producto': { status: 500, body: 'boom' } },
  });

  await anadirYEsperar('http://publica.test/producto');
  const [fallido] = enlacesDe(db);
  assert.equal(fallido.captura_estado, 'fallida');
  assert.ok(fallido.captura_error);

  // La web se recupera.
  montarWeb({ 'http://publica.test/producto': { status: 200, body: '<title>Ya va</title>' } });
  const r = await api('POST', `/api/tareas/${TAREA}/enlaces/${fallido.id_enlace}/recapturar`);

  assert.equal(r.status, 200);
  assert.equal(r.body.enlace.captura_estado, 'ok');
  assert.equal(r.body.enlace.captura_error, undefined, 'un error viejo no puede quedarse pegado al enlace');
  assert.equal(enlacesDe(db)[0].titulo, 'Ya va');
});

/** Cambia solo la web, conservando la base de datos ya montada. */
function montarWeb(web) {
  configurarTransporteEnlaces({
    fetch: async (href) => {
      const definicion = web[href];
      if (definicion === undefined) return new Response('no existe', { status: 404 });
      const { status = 200, headers = {}, body = '' } = definicion;
      return new Response(body, { status, headers });
    },
  });
}

test('al recapturar, si la imagen cambia de formato la clave anterior no queda huérfana', async () => {
  const paginaCon = (imagen) => ({
    'http://publica.test/producto': {
      status: 200,
      body: HTML_FICHA,
      headers: { 'content-type': 'text/html' },
    },
    'http://publica.test/media/taburete.png': {
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: imagen,
    },
  });
  const { db, espia } = montar({ web: paginaCon(IMAGEN_PNG) });

  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);
  assert.match(enlace.imagen_s3_key, /\.png$/);
  assert.deepEqual(espia.borrados, []);

  // La web cambia la foto por un JPEG. El tipo sale de los bytes y la clave lleva
  // la extensión, así que la nueva imagen se guarda en otro objeto.
  montarWeb(paginaCon(IMAGEN_JPEG));
  const r = await api('POST', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/recapturar`);
  assert.equal(r.status, 200);
  assert.match(r.body.enlace.imagen_s3_key, /\.jpg$/);
  assert.deepEqual(
    espia.borrados,
    [enlace.imagen_s3_key],
    'la anterior se borra: ya no la apunta nadie y se pagaría para siempre',
  );

  // Recapturar sin cambio de formato no borra nada: la subida sobrescribe la clave.
  const antes = espia.borrados.length;
  const otra = await api('POST', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/recapturar`);
  assert.equal(otra.status, 200);
  assert.equal(espia.borrados.length, antes);
});

test('recapturar un enlace que no existe responde 404', async () => {
  montar();
  const r = await api('POST', `/api/tareas/${TAREA}/enlaces/no-existe/recapturar`);
  assert.equal(r.status, 404);
});

// ─── URL de lectura de la imagen ───

const WEB_CON_IMAGEN = {
  'http://publica.test/producto': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
  'http://publica.test/media/taburete.png': {
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: IMAGEN_PNG,
  },
};

test('la URL de lectura de la imagen se firma para una hora', async () => {
  const { db, espia } = montar({ web: WEB_CON_IMAGEN });
  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);
  assert.ok(enlace.imagen_s3_key);

  const r = await api('GET', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/imagen`);
  assert.equal(r.status, 200);
  assert.equal(r.body.expira_en_seg, 3600);
  assert.ok(r.body.url.includes('firma=lectura'));
  assert.equal(r.body.enlace.id_enlace, enlace.id_enlace);
  assert.deepEqual(espia.firmadasLectura, [enlace.imagen_s3_key]);
});

test('pedir la imagen de un enlace sin captura de imagen responde 404', async () => {
  const { db } = montar({
    web: { 'http://publica.test/producto': { status: 200, body: '<title>Sin foto</title>' } },
  });
  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);
  assert.equal(enlace.imagen_s3_key, undefined);

  const r = await api('GET', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/imagen`);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /imagen/i);
});

test('pedir la imagen de un enlace que no existe responde 404', async () => {
  montar();
  const r = await api('GET', `/api/tareas/${TAREA}/enlaces/no-existe/imagen`);
  assert.equal(r.status, 404);
});

test('quien no ve la tarea recibe 404 al pedir la URL de la imagen', async () => {
  const { db } = montar({ web: WEB_CON_IMAGEN });
  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);

  const r = await api('GET', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/imagen`, undefined, BEA);
  assert.equal(r.status, 404, 'un 403 confirmaría que la tarea existe');
});

// ─── Borrado ───

test('borrar el enlace borra también la imagen de S3', async () => {
  const { db, espia } = montar({
    web: {
      'http://publica.test/producto': { status: 200, body: HTML_FICHA, headers: { 'content-type': 'text/html' } },
      'http://publica.test/media/taburete.png': {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: IMAGEN_PNG,
      },
    },
  });

  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);

  const r = await api('DELETE', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}`);
  assert.equal(r.status, 200);
  assert.deepEqual(enlacesDe(db), []);
  assert.deepEqual(espia.borrados, [enlace.imagen_s3_key], 'la imagen no puede quedarse huérfana en el bucket');
});

test('una captura que llega tarde no resucita un enlace ya borrado', async () => {
  let soltar;
  const esperaWeb = new Promise((listo) => {
    soltar = listo;
  });
  const { db } = montar({
    web: {
      'http://publica.test/lenta': async () => {
        await esperaWeb;
        return new Response(HTML_FICHA, { status: 200, headers: { 'content-type': 'text/html' } });
      },
    },
  });

  const creado = await anadir('http://publica.test/lenta');
  const idEnlace = creado.body.enlace.id_enlace;

  const borrado = await api('DELETE', `/api/tareas/${TAREA}/enlaces/${idEnlace}`);
  assert.equal(borrado.status, 200);

  soltar();
  await esperarCapturasPendientes();
  assert.deepEqual(enlacesDe(db), [], 'la captura tardía no debe volver a escribir la fila');
});

// ─── Acceso ───

test('quien no ve la tarea no puede añadir, recapturar ni borrar enlaces, y recibe 404', async () => {
  const { db } = montar({
    web: { 'http://publica.test/producto': { status: 200, body: HTML_FICHA } },
  });
  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);

  const creado = await anadir('http://publica.test/producto', CARLOS);
  assert.equal(creado.status, 404, 'un 403 confirmaría que la tarea existe');

  const recaptura = await api(
    'POST',
    `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}/recapturar`,
    {},
    CARLOS,
  );
  assert.equal(recaptura.status, 404);

  const borrado = await api('DELETE', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}`, undefined, CARLOS);
  assert.equal(borrado.status, 404);
  assert.equal(enlacesDe(db).length, 1);
});

// ─── Historial ───

test('añadir, capturar y borrar quedan en el historial de la tarea', async () => {
  const { db } = montar({
    web: { 'http://publica.test/producto': { status: 200, body: HTML_FICHA } },
  });

  await anadirYEsperar('http://publica.test/producto');
  const [enlace] = enlacesDe(db);
  await api('DELETE', `/api/tareas/${TAREA}/enlaces/${enlace.id_enlace}`);

  const acciones = db
    .listar(tables.actividad)
    .filter((a) => a.PK === `TAREA#${TAREA}`)
    .map((a) => a.accion);
  assert.deepEqual(acciones.sort(), ['enlace_anadido', 'enlace_borrado', 'enlace_capturado']);
});

// ─── Utilidades puras ───

test('validarUrlEnlace acepta http y https y rechaza lo demás', () => {
  assert.equal(validarUrlEnlace('https://ejemplo.test/x').ok, true);
  assert.equal(validarUrlEnlace('http://ejemplo.test/x').ok, true);
  assert.equal(validarUrlEnlace('   ').ok, false);
  assert.equal(validarUrlEnlace('ejemplo.test/sin-esquema').ok, false);
  assert.equal(validarUrlEnlace('javascript:alert(1)').ok, false);
});

test('una URL con credenciales se rechaza: disfraza el destino y filtra la clave', () => {
  // Lo de antes de la `@` no es el destino: `http://publica.test@interno/` va a
  // `interno`. Y la clave acabaría en los registros.
  for (const url of [
    'http://usuario:clave@publica.test/x',
    'https://publica.test@interno.test/x',
    'http://:clave@publica.test/x',
  ]) {
    const r = validarUrlEnlace(url);
    assert.equal(r.ok, false, url);
    assert.match(r.error, /usuario ni contraseña/);
  }
});

test('el enlace con credenciales no se guarda ni se sale a la web', async () => {
  const { db, espia } = montar();
  const r = await anadir('http://usuario:clave@publica.test/producto');
  assert.equal(r.status, 400);
  assert.deepEqual(enlacesDe(db), []);
  assert.deepEqual(espia.peticiones, []);
});

test('precioDeTexto distingue el separador decimal por su posición', () => {
  assert.equal(precioDeTexto('1.234,50 €'), 1234.5);
  assert.equal(precioDeTexto('1,234.50'), 1234.5);
  assert.equal(precioDeTexto('89'), 89);
  assert.equal(precioDeTexto('89,90'), 89.9);
  assert.equal(precioDeTexto('sin precio'), null);
});

test('la imagen se sube cifrada: ServerSideEncryption explícito', () => {
  const parametros = parametrosSubidaImagen({
    key: 'tasks/tareas/t/enlaces/e.png',
    cuerpo: IMAGEN_PNG,
    contentType: 'image/png',
  });
  assert.equal(parametros.ServerSideEncryption, 'AES256');
});

test('extraerMetadatos prefiere og:title y desescapa las entidades', () => {
  const meta = extraerMetadatos(
    '<title>Barra &amp; taburetes</title><meta property="og:price:amount" content="12,00">',
  );
  assert.equal(meta.titulo, 'Barra & taburetes');
  assert.equal(meta.precio, 12);
});
