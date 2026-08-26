/**
 * Enlaces externos de una tarea, con **captura en servidor**.
 *
 * Es la parte del módulo con más superficie de ataque: aquí el servidor
 * descarga una URL que escribe el usuario. Sin las comprobaciones de este
 * fichero, cualquiera con permiso para editar una tarea convierte la API en un
 * proxy hacia la red interna (SSRF): `http://169.254.169.254/…` devuelve las
 * credenciales de la instancia, y `http://10.x.x.x/` alcanza servicios que no
 * están publicados.
 *
 * **Antes de simplificar nada de lo que hay aquí**, estas son las razones:
 *
 * 1. **Solo `http` y `https`.** `file:`, `gopher:` y `data:` leen el disco del
 *    servidor o hablan con protocolos que no se controlan. La lista es cerrada
 *    en código y la configuración solo puede recortarla, nunca ampliarla.
 * 2. **Se resuelve el dominio y se rechazan las direcciones privadas.** Validar
 *    el nombre no basta: `interno.ejemplo.com` puede apuntar a `10.0.0.5`.
 * 3. **La comprobación se repite en cada salto.** Es la regla que justifica
 *    todo lo demás: una URL pública que redirige a `169.254.169.254` se cuela
 *    entera si solo se valida la primera. Por eso **no** se usa el seguimiento
 *    automático de redirecciones (`redirect: 'follow'`), que las sigue sin
 *    dejar validar nada: se siguen a mano.
 * 4. **Máximo 2 redirecciones**, tiempo de espera y tamaño acotados: si no, una
 *    web hostil deja peticiones colgadas y memoria comiéndose el proceso.
 * 5. **Del cuerpo se leen solo los primeros KB** y se corta el flujo. Los
 *    metadatos que interesan (`<title>`, `og:*`, precio) están en la cabecera
 *    del documento; descargar el resto solo sirve para que un `Content-Length`
 *    mentiroso tumbe el proceso.
 * 6. **La imagen se valida por sus bytes**, no por el `Content-Type` que
 *    declare el servidor remoto, que es un dato que controla el atacante.
 * 7. **Sin credenciales en la URL.** `http://usuario:clave@host/` se rechaza:
 *    no hay enlace de tarea que las necesite, y sirven para disfrazar el destino
 *    y para filtrar la clave a los registros.
 *
 * Y una limitación conocida que conviene tener presente: entre la resolución de
 * DNS y la conexión real hay una ventana en la que el nombre podría cambiar de
 * dirección (*DNS rebinding*). Cerrarla exige conectar contra la IP ya
 * comprobada, y con lo que hay en el repositorio eso significa una de dos:
 * un dispatcher de `undici` —que no es dependencia del proyecto— o reescribir la
 * descarga sobre `node:https` fijando `lookup`/`servername`, lo que obliga a
 * rehacer a mano el flujo de cuerpo, el corte por bytes y el plazo, es decir, lo
 * más delicado del fichero. Se ha evaluado y **no se hace**: el atacante necesita
 * además control del DNS del dominio, y las comprobaciones de arriba —repetidas
 * en cada salto— cortan el caso realista. Queda anotado aquí para quien vuelva.
 *
 * Un fallo de captura **no es un fallo del endpoint**: el enlace queda en
 * `fallida` con su motivo y la tarea sigue viva. Ver
 * `docs/tasks/03-contrato-api.md`, «Enlaces con captura».
 */

import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables } from '../db.js';
import { detectMimeFromMagic } from '../uploadAllowlist.js';
import { PK, SK } from './tipos.js';
import { ACCIONES, registrarActividad } from './actividad.js';
import { cargarParaEscribir, cargarParaVer, salidaFilaHija } from './tareas.js';

// ─── Configuración ───

/** Ítem de `Igp_Ajustes` con los límites de la captura. */
export const AJUSTES_ENLACES = Object.freeze({ PK: 'proyectos', SK: 'enlaces' });

/**
 * Esquemas admitidos, **en código y no en configuración**. La configuración
 * puede recortar esta lista pero nunca ampliarla: si `esquemas_permitidos`
 * mandara del todo, quien pudiera escribir en `Igp_Ajustes` añadiría `file:` y
 * convertiría la captura en un lector del disco del servidor.
 */
const ESQUEMAS_ADMITIDOS = Object.freeze(['http:', 'https:']);

/** Tope duro de redirecciones. La configuración solo puede bajarlo. */
const MAX_REDIRECCIONES = 2;

const PREFIJO_S3 = process.env.TASKS_S3_PREFIX || 'tasks';

/** Lectura de una hora, igual que los adjuntos. */
export const SEGUNDOS_LECTURA = 3600;

/** Los dos primeros salen de variables de entorno documentadas en 02-modelo-datos. */
function ajustesPorDefecto() {
  return {
    timeout_ms: aEnteroPositivo(process.env.TASKS_ENLACE_TIMEOUT_MS, 8000),
    max_bytes: aEnteroPositivo(process.env.TASKS_ENLACE_MAX_BYTES, 64 * 1024),
    max_bytes_imagen: 2 * 1024 * 1024,
    max_redirecciones: MAX_REDIRECCIONES,
    esquemas_permitidos: [...ESQUEMAS_ADMITIDOS],
  };
}

function aEnteroPositivo(valor, porDefecto) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto;
}

/**
 * Límites de la captura, de `Igp_Ajustes` con los valores por defecto del
 * código como respaldo.
 *
 * Un fallo al leer la configuración **no** cancela la captura: se sigue con los
 * valores por defecto, que son los conservadores.
 */
export async function leerAjustesEnlaces() {
  const base = ajustesPorDefecto();
  let item = null;
  try {
    const r = await docClient.send(
      new GetCommand({ TableName: tables.ajustes, Key: { PK: AJUSTES_ENLACES.PK, SK: AJUSTES_ENLACES.SK } }),
    );
    item = r.Item || null;
  } catch (err) {
    console.warn('[tasks/enlaces] no se pudo leer la configuración de enlaces', err?.message || err);
  }
  if (!item) return base;

  const esquemas = Array.isArray(item.esquemas_permitidos)
    ? item.esquemas_permitidos
        .map((e) => String(e || '').trim().toLowerCase())
        .map((e) => (e.endsWith(':') ? e : `${e}:`))
        .filter((e) => ESQUEMAS_ADMITIDOS.includes(e))
    : base.esquemas_permitidos;

  return {
    timeout_ms: aEnteroPositivo(item.timeout_ms, base.timeout_ms),
    max_bytes: aEnteroPositivo(item.max_bytes, base.max_bytes),
    max_bytes_imagen: aEnteroPositivo(item.max_bytes_imagen, base.max_bytes_imagen),
    // Nunca por encima del tope duro: la configuración recorta, no amplía.
    max_redirecciones: Math.min(aEnteroPositivo(item.max_redirecciones, base.max_redirecciones), MAX_REDIRECCIONES),
    esquemas_permitidos: esquemas.length > 0 ? esquemas : base.esquemas_permitidos,
  };
}

// ─── Transporte inyectable ───

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';

/**
 * Salidas al exterior de este módulo, en un solo sitio para poder sustituirlas
 * en las pruebas: probar la protección contra SSRF saliendo de verdad a la red
 * no es una opción.
 */
/**
 * Parámetros del `PutObject` de la imagen capturada.
 *
 * `ServerSideEncryption` va explícito y no se deja al valor por defecto del
 * bucket: es un requisito del módulo (`docs/tasks/02-modelo-datos.md`, «Objetos
 * en S3») y un cambio de configuración del bucket no debe poder desactivarlo
 * sin que salte ninguna prueba.
 */
export function parametrosSubidaImagen({ key, cuerpo, contentType }) {
  return {
    Bucket: S3_BUCKET,
    Key: key,
    Body: cuerpo,
    ContentType: contentType,
    ServerSideEncryption: 'AES256',
  };
}

export const transporteEnlaces = {
  fetch: (url, opciones) => globalThis.fetch(url, opciones),
  /** @returns {Promise<Array<string|{address:string}>>} */
  resolverDns: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  subirImagen: async ({ key, cuerpo, contentType }) => {
    await s3.send(new PutObjectCommand(parametrosSubidaImagen({ key, cuerpo, contentType })));
  },
  urlLectura: ({ key }) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: SEGUNDOS_LECTURA }),
  borrarImagen: async ({ key }) => {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  },
};

/**
 * Sustituye parte del transporte y devuelve la función que lo restaura.
 * Pensado para las pruebas; en producción nadie lo llama.
 */
export function configurarTransporteEnlaces(parcial = {}) {
  const previo = { ...transporteEnlaces };
  Object.assign(transporteEnlaces, parcial);
  return () => Object.assign(transporteEnlaces, previo);
}

// ─── Direcciones que no se visitan ───

function aBytesIpv4(texto) {
  const partes = String(texto).split('.');
  if (partes.length !== 4) return null;
  const bytes = [];
  for (const p of partes) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/** Expande una IPv6 a sus 16 bytes, resolviendo `::` y la forma con IPv4 al final. */
function aBytesIpv6(texto) {
  const sinZona = String(texto).split('%')[0];
  if (!net.isIPv6(sinZona)) return null;
  const mitades = sinZona.split('::');
  if (mitades.length > 2) return null;

  const grupos = (trozo) => {
    const salida = [];
    for (const g of trozo ? trozo.split(':') : []) {
      if (g === '') continue;
      if (g.includes('.')) {
        const v4 = aBytesIpv4(g);
        if (!v4) return null;
        salida.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        salida.push(Number.parseInt(g, 16));
      }
    }
    return salida;
  };

  const cabeza = grupos(mitades[0]);
  const cola = mitades.length === 2 ? grupos(mitades[1]) : [];
  if (!cabeza || !cola) return null;
  const relleno = 8 - cabeza.length - cola.length;
  if (relleno < 0) return null;
  const palabras = [...cabeza, ...new Array(Math.max(relleno, 0)).fill(0), ...cola];
  if (palabras.length !== 8) return null;

  const bytes = [];
  for (const p of palabras) bytes.push((p >> 8) & 0xff, p & 0xff);
  return bytes;
}

function ipv4Privada(b) {
  // 0.0.0.0/8 — «esta red». Muchas pilas la tratan como localhost.
  if (b[0] === 0) return true;
  if (b[0] === 10) return true;
  if (b[0] === 127) return true;
  // 100.64/10 — CGNAT: red del operador, no internet pública.
  if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return true;
  // 169.254/16 — enlace local. Aquí vive el servicio de metadatos de la nube.
  if (b[0] === 169 && b[1] === 254) return true;
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true;
  // 192.0.0/24 (asignaciones IETF) y 192.0.2/24 (documentación).
  if (b[0] === 192 && b[1] === 0 && (b[2] === 0 || b[2] === 2)) return true;
  if (b[0] === 192 && b[1] === 168) return true;
  // 198.18/15 — pruebas de rendimiento entre redes.
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return true;
  if (b[0] === 198 && b[1] === 51 && b[2] === 100) return true;
  if (b[0] === 203 && b[1] === 0 && b[2] === 113) return true;
  // 224/4 multicast y 240/4 reservado, incluida 255.255.255.255.
  if (b[0] >= 224) return true;
  return false;
}

/**
 * `true` si la dirección **no** debe visitarse: privada, local, reservada o
 * ilegible. Lo desconocido cuenta como privado, que es el lado seguro.
 *
 * Contempla las formas en las que una IPv4 interna se disfraza de IPv6
 * (`::ffff:10.0.0.1`, NAT64 y 6to4): sin eso, la lista de rangos IPv4 se
 * esquiva escribiendo la misma dirección de otra manera.
 *
 * @param {string} ip
 */
export function esDireccionPrivada(ip) {
  const t = String(ip || '').trim();
  if (!t) return true;

  const v4 = net.isIPv4(t) ? aBytesIpv4(t) : null;
  if (v4) return ipv4Privada(v4);

  const b = aBytesIpv6(t);
  if (!b) return true;

  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 — únicas locales
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 — enlace local
  if (b[0] === 0xff) return true; // ff00::/8 — multicast

  // ::ffff:a.b.c.d — IPv4 mapeada.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return ipv4Privada(b.slice(12));
  }
  // ::a.b.c.d — IPv4 compatible (obsoleta, pero las pilas la siguen entendiendo):
  // `http://[::169.254.169.254]/` alcanza el servicio de metadatos igual que la
  // forma mapeada. Va aquí, después de `::` y `::1`, que son casos suyos.
  if (b.slice(0, 12).every((x) => x === 0)) return ipv4Privada(b.slice(12));
  // 64:ff9b::/96 — NAT64.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return ipv4Privada(b.slice(12));
  }
  // 2002::/16 — 6to4: los cuatro bytes siguientes son la IPv4 encapsulada.
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4Privada(b.slice(2, 6));

  return false;
}

// ─── Validación de la URL ───

/**
 * Comprueba forma y esquema de la URL que escribe el usuario.
 *
 * @param {string} bruto
 * @param {string[]} [esquemas] Esquemas efectivos, ya recortados por configuración.
 * @returns {{ ok: true, url: URL } | { ok: false, error: string }}
 */
export function validarUrlEnlace(bruto, esquemas = ESQUEMAS_ADMITIDOS) {
  const t = String(bruto ?? '').trim();
  if (!t) return { ok: false, error: 'El enlace no puede estar vacío' };

  let url;
  try {
    url = new URL(t);
  } catch {
    return { ok: false, error: 'El enlace no es una dirección válida' };
  }

  const protocolo = url.protocol.toLowerCase();
  const nombre = protocolo.replace(':', '');
  if (!ESQUEMAS_ADMITIDOS.includes(protocolo)) {
    return { ok: false, error: `Solo se admiten enlaces http o https; «${nombre}» no vale` };
  }
  if (!esquemas.includes(protocolo)) {
    return { ok: false, error: `La configuración no permite enlaces «${nombre}»; usa https` };
  }
  if (!url.hostname) return { ok: false, error: 'El enlace no tiene dominio' };
  // `http://usuario:clave@host/` no tiene uso legítimo en un enlace de tarea y sí
  // dos usos malos: es la forma clásica de confundir a quien lee la URL sobre a
  // qué dominio va —lo de antes de la `@` no es el destino—, y manda las
  // credenciales al servidor remoto y a nuestros registros.
  if (url.username || url.password) {
    return { ok: false, error: 'El enlace no puede llevar usuario ni contraseña en la dirección' };
  }
  return { ok: true, url };
}

/** Error de captura: lleva un motivo en español que se guarda en el enlace. */
class ErrorCaptura extends Error {}

function anfitrion(url) {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * Resuelve el dominio y rechaza el destino si **alguna** de sus direcciones es
 * privada. Se miran todas y no solo la primera: un dominio con varios registros
 * A puede mezclar una pública y una interna, y qué devuelve el sistema en cada
 * intento no lo decidimos nosotros.
 */
async function comprobarDestinoPublico(url) {
  const host = anfitrion(url);
  let crudo;
  try {
    crudo = await transporteEnlaces.resolverDns(host);
  } catch {
    throw new ErrorCaptura('No se ha podido resolver el dominio del enlace');
  }
  const direcciones = (Array.isArray(crudo) ? crudo : [crudo])
    .map((d) => (typeof d === 'string' ? d : d?.address))
    .filter(Boolean);
  if (direcciones.length === 0) {
    throw new ErrorCaptura('El dominio del enlace no resuelve a ninguna dirección');
  }
  for (const ip of direcciones) {
    if (esDireccionPrivada(ip)) {
      throw new ErrorCaptura('El enlace apunta a una dirección de red interna');
    }
  }
}

// ─── Descarga acotada ───

const CODIGOS_REDIRECCION = new Set([301, 302, 303, 307, 308]);

/**
 * Petición con las comprobaciones de seguridad **en cada salto**.
 *
 * Las redirecciones se siguen a mano (`redirect: 'manual'`) precisamente para
 * poder volver a validar esquema y dirección antes de cada nueva conexión. Con
 * el seguimiento automático, el primer `Location` hacia `169.254.169.254` se
 * visitaría sin que este código llegue a verlo.
 *
 * @returns {Promise<{ res: Response, url: URL }>}
 */
async function pedirConGuardas(urlInicial, { ajustes, finPlazo, accept }) {
  let actual = urlInicial;

  for (let salto = 0; salto <= ajustes.max_redirecciones; salto += 1) {
    const validada = validarUrlEnlace(actual.href, ajustes.esquemas_permitidos);
    if (!validada.ok) throw new ErrorCaptura(validada.error);
    await comprobarDestinoPublico(validada.url);

    const restante = finPlazo - Date.now();
    if (restante <= 0) throw new ErrorCaptura('La web ha tardado demasiado en responder');

    let res;
    try {
      res = await transporteEnlaces.fetch(validada.url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(restante),
        headers: {
          Accept: accept,
          'Accept-Language': 'es-ES,es;q=0.9',
          'User-Agent': 'IGP-2.0 (captura de enlace de tarea)',
        },
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new ErrorCaptura('La web ha tardado demasiado en responder');
      }
      throw new ErrorCaptura('No se ha podido conectar con la web del enlace');
    }

    const estado = Number(res?.status) || 0;
    if (CODIGOS_REDIRECCION.has(estado)) {
      const destino = res.headers?.get?.('location');
      await cerrarCuerpo(res);
      if (!destino) throw new ErrorCaptura('La web respondió una redirección sin destino');
      if (salto === ajustes.max_redirecciones) {
        throw new ErrorCaptura(`La web encadena más de ${ajustes.max_redirecciones} redirecciones`);
      }
      try {
        actual = new URL(destino, validada.url);
      } catch {
        throw new ErrorCaptura('La redirección apunta a una dirección que no se entiende');
      }
      continue;
    }

    if (estado < 200 || estado >= 300) {
      await cerrarCuerpo(res);
      throw new ErrorCaptura(`La web respondió con el código ${estado}`);
    }
    return { res, url: validada.url };
  }

  throw new ErrorCaptura(`La web encadena más de ${ajustes.max_redirecciones} redirecciones`);
}

async function cerrarCuerpo(res) {
  try {
    await res?.body?.cancel?.();
  } catch {
    // El cuerpo ya estaba cerrado: no es un problema.
  }
}

/**
 * Lee **como mucho** `limite` bytes y corta el flujo.
 *
 * No se usa `arrayBuffer()` salvo que no haya flujo: acumularía el cuerpo
 * entero en memoria antes de que nadie pudiera comprobar su tamaño, y el
 * `Content-Length` de una web hostil no vale como límite porque lo escribe ella.
 */
async function leerHasta(res, limite) {
  const cuerpo = res?.body;
  if (!cuerpo || typeof cuerpo.getReader !== 'function') {
    const entero = Buffer.from(await res.arrayBuffer());
    return entero.subarray(0, limite);
  }

  const lector = cuerpo.getReader();
  const trozos = [];
  let total = 0;
  try {
    while (total < limite) {
      const { done, value } = await lector.read();
      if (done) break;
      const trozo = Buffer.from(value);
      trozos.push(trozo);
      total += trozo.length;
    }
  } finally {
    // Corta la descarga: sin esto, el resto del cuerpo seguiría llegando.
    await lector.cancel().catch(() => {});
  }
  return Buffer.concat(trozos).subarray(0, limite);
}

// ─── Metadatos del documento ───

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function desescapar(texto) {
  return String(texto || '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entera, nombre) => {
      const clave = nombre.toLowerCase();
      if (ENTIDADES[clave] !== undefined) return ENTIDADES[clave];
      if (/^#\d+$/.test(clave)) return String.fromCodePoint(Number(clave.slice(1)));
      if (/^#x[0-9a-f]+$/.test(clave)) return String.fromCodePoint(Number.parseInt(clave.slice(2), 16));
      return entera;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function contenidoMeta(html, propiedad) {
  const re = new RegExp(
    `<meta[^>]*\\s(?:property|name|itemprop)\\s*=\\s*["']${propiedad}["'][^>]*>`,
    'i',
  );
  const etiqueta = html.match(re)?.[0];
  if (!etiqueta) return '';
  return desescapar(etiqueta.match(/\scontent\s*=\s*["']([^"']*)["']/i)?.[1] || '');
}

/**
 * Número a partir del texto de un precio. Distingue el separador decimal por su
 * posición, porque `1.234,56` y `1,234.56` son el mismo importe escrito en dos
 * sitios distintos y quedarse con uno multiplica o divide por mil.
 */
export function precioDeTexto(bruto) {
  const limpio = String(bruto ?? '').replace(/[^\d.,]/g, '').trim();
  if (!limpio) return null;
  const coma = limpio.lastIndexOf(',');
  const punto = limpio.lastIndexOf('.');
  const normal = coma > punto ? limpio.replace(/\./g, '').replace(',', '.') : limpio.replace(/,/g, '');
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const MONEDA_POR_SIMBOLO = { '€': 'EUR', $: 'USD', '£': 'GBP' };

function decodificar(bytes, contentType) {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))?.[1]?.toLowerCase();
  const latinos = ['iso-8859-1', 'latin1', 'windows-1252', 'cp1252'];
  if (charset && latinos.includes(charset)) return bytes.toString('latin1');
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * Título, imagen, precio y moneda de la cabecera del documento.
 * @param {string} html Solo los primeros KB del cuerpo.
 */
export function extraerMetadatos(html) {
  const titulo =
    contenidoMeta(html, 'og:title') ||
    desescapar(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
    contenidoMeta(html, 'twitter:title');

  const imagen =
    contenidoMeta(html, 'og:image:secure_url') ||
    contenidoMeta(html, 'og:image') ||
    contenidoMeta(html, 'twitter:image');

  const precio = precioDeTexto(
    contenidoMeta(html, 'og:price:amount') ||
      contenidoMeta(html, 'product:price:amount') ||
      contenidoMeta(html, 'price'),
  );

  const monedaBruta =
    contenidoMeta(html, 'og:price:currency') || contenidoMeta(html, 'product:price:currency') || contenidoMeta(html, 'priceCurrency');
  let moneda = monedaBruta.toUpperCase().slice(0, 3);
  if (!moneda && precio != null) {
    const simbolo = Object.keys(MONEDA_POR_SIMBOLO).find((s) => html.includes(s));
    if (simbolo) moneda = MONEDA_POR_SIMBOLO[simbolo];
  }

  return {
    titulo: titulo.slice(0, 300),
    imagen,
    precio,
    moneda: /^[A-Z]{3}$/.test(moneda) ? moneda : '',
  };
}

// ─── Imagen ───

const EXTENSION_POR_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function claveImagenEnlace(idTarea, idEnlace, extension) {
  return `${PREFIJO_S3}/tareas/${idTarea}/enlaces/${idEnlace}.${extension}`;
}

/**
 * Descarga la imagen del destino y la sube a S3.
 *
 * Se guarda copia propia y no se enlaza la del destino a propósito: los datos
 * capturados son la foto de un momento y la tarjeta tiene que seguir viéndose
 * dentro de seis meses, que es justo cuando la prueba importa.
 *
 * El tipo se decide por los **bytes** (`detectMimeFromMagic`), nunca por el
 * `Content-Type` que declare el servidor remoto: es un dato que controla quien
 * sirve el fichero, así que aceptar un `image/png` que en realidad es un HTML
 * —o un ejecutable— sería guardar lo que él quiera bajo nombre de imagen.
 *
 * @returns {Promise<{ key: string, contentType: string } | null>}
 */
async function capturarImagen({ idTarea, idEnlace, urlImagen, ajustes, finPlazo }) {
  const { res } = await pedirConGuardas(urlImagen, { ajustes, finPlazo, accept: 'image/*' });

  const declarado = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declarado) && declarado > ajustes.max_bytes_imagen) {
    await cerrarCuerpo(res);
    throw new ErrorCaptura('La imagen del enlace supera el tamaño máximo');
  }

  // Un byte más que el límite: si lo que vuelve lo supera, es que había más.
  const bytes = await leerHasta(res, ajustes.max_bytes_imagen + 1);
  if (bytes.length > ajustes.max_bytes_imagen) {
    throw new ErrorCaptura('La imagen del enlace supera el tamaño máximo');
  }

  const mime = detectMimeFromMagic(bytes);
  const extension = mime ? EXTENSION_POR_MIME[mime] : null;
  if (!extension) throw new ErrorCaptura('El fichero de imagen del enlace no es una imagen');

  const key = claveImagenEnlace(idTarea, idEnlace, extension);
  await transporteEnlaces.subirImagen({ key, cuerpo: bytes, contentType: mime });
  return { key, contentType: mime };
}

// ─── Captura ───

/**
 * Descarga el destino y devuelve lo capturado. No escribe en DynamoDB: la
 * separación permite probar la protección contra SSRF sin tabla delante.
 *
 * @returns {Promise<{ titulo: string, precio: number|null, moneda: string, imagen_s3_key: string }>}
 */
export async function capturarDestino({ idTarea, idEnlace, url, ajustes }) {
  const finPlazo = Date.now() + ajustes.timeout_ms;
  const { res, url: urlFinal } = await pedirConGuardas(new URL(url), {
    ajustes,
    finPlazo,
    accept: 'text/html,application/xhtml+xml',
  });

  const bytes = await leerHasta(res, ajustes.max_bytes);
  const html = decodificar(bytes, res.headers?.get?.('content-type'));
  const meta = extraerMetadatos(html);

  let imagenKey = '';
  if (meta.imagen) {
    try {
      const subida = await capturarImagen({
        idTarea,
        idEnlace,
        urlImagen: new URL(meta.imagen, urlFinal),
        ajustes,
        finPlazo,
      });
      imagenKey = subida?.key || '';
    } catch (err) {
      // Que la imagen falle no invalida el título ni el precio: la captura sigue
      // siendo útil sin la miniatura.
      console.warn('[tasks/enlaces] no se pudo capturar la imagen', idEnlace, err?.message || err);
    }
  }

  return { titulo: meta.titulo, precio: meta.precio, moneda: meta.moneda, imagen_s3_key: imagenKey };
}

// ─── Trabajo en segundo plano ───

/** Capturas en vuelo, para poder esperarlas al cerrar el proceso y en las pruebas. */
const enVuelo = new Set();

/**
 * Espera a que terminen las capturas lanzadas y no esperadas. Las pruebas la
 * usan para no depender de temporizadores.
 */
export async function esperarCapturasPendientes() {
  while (enVuelo.size > 0) {
    await Promise.all([...enVuelo]);
  }
}

/**
 * Ejecuta la captura y guarda el resultado en el ítem del enlace.
 *
 * **Nunca lanza**: un fallo del sitio remoto deja el enlace en `fallida` con su
 * motivo, y el endpoint que la disparó ya respondió correctamente. Propagarlo
 * convertiría la caída de una web ajena en un `500` nuestro.
 */
async function capturarYGuardar({ ctx, idTarea, enlace }) {
  const ajustes = await leerAjustesEnlaces();
  let cambios;
  let error = '';

  try {
    const capturado = await capturarDestino({
      idTarea,
      idEnlace: enlace.id_enlace,
      url: enlace.url,
      ajustes,
    });
    cambios = {
      captura_estado: 'ok',
      titulo: capturado.titulo,
      precio: capturado.precio,
      moneda: capturado.moneda,
      imagen_s3_key: capturado.imagen_s3_key,
      capturado_en: new Date().toISOString(),
      captura_error: '',
    };
  } catch (err) {
    error = err instanceof ErrorCaptura ? err.message : 'No se ha podido capturar el enlace';
    if (!(err instanceof ErrorCaptura)) {
      console.error('[tasks/enlaces] fallo inesperado capturando', enlace.id_enlace, err);
    }
    cambios = {
      captura_estado: 'fallida',
      captura_error: error,
      capturado_en: new Date().toISOString(),
    };
  }

  const guardado = await escribirEnlace(idTarea, enlace.id_enlace, cambios);
  // Si el enlace ya no está (lo borraron mientras se capturaba), no se resucita
  // ni se registra actividad de algo que no existe.
  if (!guardado) return null;

  await registrarActividad({
    tipo: 'tarea',
    entidadId: idTarea,
    accion: ACCIONES.enlaceCapturado,
    usuario: { id_usuario: ctx?.idUsuario, Nombre: ctx?.nombre },
    detalle: {
      id_enlace: enlace.id_enlace,
      estado: cambios.captura_estado,
      ...(error && { error }),
    },
  });
  return salidaFilaHija(guardado);
}

function enSegundoPlano(promesa) {
  const seguro = promesa.catch((err) => {
    console.error('[tasks/enlaces] la captura en segundo plano falló', err);
    return null;
  });
  enVuelo.add(seguro);
  seguro.finally(() => enVuelo.delete(seguro));
  return seguro;
}

// ─── Persistencia ───

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function autorDe(ctx) {
  return { id_usuario: texto(ctx?.idUsuario), Nombre: texto(ctx?.nombre) };
}

async function leerEnlace(idTarea, idEnlace) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.tareas,
      Key: { PK: PK.tarea(idTarea), SK: SK.enlace(idEnlace) },
    }),
  );
  return r.Item || null;
}

/**
 * Aplica cambios sobre el ítem del enlace. Un valor vacío se traduce en
 * `REMOVE`, para que un enlace recapturado con éxito no conserve el
 * `captura_error` de la vez anterior.
 *
 * La condición `attribute_exists(PK)` evita que una captura que llega tarde
 * recree un enlace ya borrado.
 */
async function escribirEnlace(idTarea, idEnlace, cambios) {
  const nombres = { '#pk': 'PK' };
  const valores = {};
  const sets = [];
  const removes = [];
  let i = 0;
  for (const [campo, valor] of Object.entries(cambios)) {
    const alias = `#c${i}`;
    nombres[alias] = campo;
    if (valor === null || valor === undefined || valor === '') {
      removes.push(alias);
    } else {
      sets.push(`${alias} = :v${i}`);
      valores[`:v${i}`] = valor;
    }
    i += 1;
  }
  const partes = [];
  if (sets.length) partes.push(`SET ${sets.join(', ')}`);
  if (removes.length) partes.push(`REMOVE ${removes.join(', ')}`);
  if (partes.length === 0) return null;

  try {
    const r = await docClient.send(
      new UpdateCommand({
        TableName: tables.tareas,
        Key: { PK: PK.tarea(idTarea), SK: SK.enlace(idEnlace) },
        UpdateExpression: partes.join(' '),
        ExpressionAttributeNames: nombres,
        ConditionExpression: 'attribute_exists(#pk)',
        ...(Object.keys(valores).length > 0 && { ExpressionAttributeValues: valores }),
        ReturnValues: 'ALL_NEW',
      }),
    );
    return r.Attributes || null;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
}

// ─── Operaciones ───

/**
 * Añade un enlace a una tarea.
 *
 * El enlace nace en `pendiente` y la respuesta **no espera a la captura**: una
 * web lenta no debe dejar al usuario mirando un botón girar durante segundos.
 * La promesa se devuelve solo para que las pruebas puedan esperarla; el router
 * la ignora.
 *
 * @returns {Promise<{ ok: true, enlace: object, captura: Promise<object|null> } | { ok: false, status: number, error: string }>}
 */
export async function anadirEnlace({ ctx, idTarea, url } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes añadir enlaces a esta tarea');
  if (!acceso.ok) return acceso;

  const ajustes = await leerAjustesEnlaces();
  const validada = validarUrlEnlace(url, ajustes.esquemas_permitidos);
  if (!validada.ok) return { ok: false, status: 400, error: validada.error };

  const id = texto(idTarea);
  const autor = autorDe(ctx);
  const idEnlace = crypto.randomUUID();
  const item = {
    PK: PK.tarea(id),
    SK: SK.enlace(idEnlace),
    id_enlace: idEnlace,
    url: validada.url.href,
    url_host: anfitrion(validada.url),
    captura_estado: 'pendiente',
    añadido_por: autor.id_usuario,
    añadido_en: new Date().toISOString(),
  };

  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: item }));

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.enlaceAnadido,
    usuario: autor,
    detalle: { id_enlace: item.id_enlace, url: item.url, url_host: item.url_host },
  });

  const captura = enSegundoPlano(capturarYGuardar({ ctx, idTarea: id, enlace: item }));
  return { ok: true, enlace: salidaFilaHija(item), captura };
}

/**
 * Vuelve a capturar un enlace. **Solo por aquí**: no hay refresco automático ni
 * al leer la tarea (los datos capturados son la foto de un momento y refrescar
 * borraría la prueba de qué se pidió y por cuánto). Como es una acción explícita
 * de una persona, esta sí espera al resultado.
 *
 * @returns {Promise<{ ok: true, enlace: object } | { ok: false, status: number, error: string }>}
 */
export async function recapturarEnlace({ ctx, idTarea, idEnlace } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes recapturar enlaces de esta tarea');
  if (!acceso.ok) return acceso;

  const id = texto(idTarea);
  const enlace = await leerEnlace(id, texto(idEnlace));
  if (!enlace) return { ok: false, status: 404, error: 'El enlace no existe' };

  const imagenAnterior = texto(enlace.imagen_s3_key);
  await escribirEnlace(id, enlace.id_enlace, { captura_estado: 'pendiente', captura_error: '' });
  const actualizado = await capturarYGuardar({ ctx, idTarea: id, enlace });
  if (!actualizado) return { ok: false, status: 404, error: 'El enlace no existe' };

  // La clave lleva la extensión del formato capturado, así que un PNG que pasa a
  // JPEG deja la anterior sin nadie que la apunte: pagándose para siempre y sin
  // forma de llegar a ella. Si la extensión no cambia, la subida ya la sobrescribió.
  const imagenNueva = texto(actualizado.imagen_s3_key);
  if (imagenAnterior && imagenAnterior !== imagenNueva) {
    try {
      await transporteEnlaces.borrarImagen({ key: imagenAnterior });
    } catch (err) {
      // La recaptura ya está guardada: que no se pueda borrar la imagen vieja no
      // es motivo para devolver error.
      console.error('[tasks/enlaces] no se pudo borrar la imagen anterior', imagenAnterior, err?.message || err);
    }
  }
  return { ok: true, enlace: actualizado };
}

/**
 * URL firmada de lectura de la imagen capturada, válida una hora. Nunca se
 * devuelve el contenido ni una URL pública del bucket.
 *
 * @returns {Promise<{ ok: true, url: string, expira_en_seg: number, enlace: object } | { ok: false, status: number, error: string }>}
 */
export async function urlDeImagenEnlace({ ctx, idTarea, idEnlace } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const enlace = await leerEnlace(texto(idTarea), texto(idEnlace));
  if (!enlace) return { ok: false, status: 404, error: 'El enlace no existe' };

  const key = texto(enlace.imagen_s3_key);
  if (!key) return { ok: false, status: 404, error: 'El enlace no tiene imagen' };

  const url = await transporteEnlaces.urlLectura({ key });
  return { ok: true, url, expira_en_seg: SEGUNDOS_LECTURA, enlace: salidaFilaHija(enlace) };
}

/**
 * Borra un enlace y, con él, la imagen que se guardó en S3: dejarla huérfana
 * sería pagar almacenamiento por algo que ya no se puede ver.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function borrarEnlace({ ctx, idTarea, idEnlace } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes borrar enlaces de esta tarea');
  if (!acceso.ok) return acceso;

  const id = texto(idTarea);
  const enlace = await leerEnlace(id, texto(idEnlace));
  if (!enlace) return { ok: false, status: 404, error: 'El enlace no existe' };

  if (texto(enlace.imagen_s3_key)) {
    try {
      await transporteEnlaces.borrarImagen({ key: enlace.imagen_s3_key });
    } catch (err) {
      // Un objeto que no se puede borrar no debe impedir quitar el enlace de la
      // tarea: quedaría una tarjeta rota que el usuario no puede eliminar.
      console.error('[tasks/enlaces] no se pudo borrar la imagen', enlace.imagen_s3_key, err?.message || err);
    }
  }

  await docClient.send(
    new DeleteCommand({
      TableName: tables.tareas,
      Key: { PK: PK.tarea(id), SK: SK.enlace(enlace.id_enlace) },
    }),
  );

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.enlaceBorrado,
    usuario: autorDe(ctx),
    detalle: { id_enlace: enlace.id_enlace, url: texto(enlace.url) },
  });

  return { ok: true };
}

// Los enlaces se leen en la ficha de la tarea (`GET /api/tareas/:id`), que ya
// los devuelve en la misma Query: no hay endpoint de un enlace suelto.
