/**
 * Adjuntos de una tarea: URLs prefirmadas y metadatos.
 *
 * El fichero **nunca pasa por la API**. El navegador lo sube directamente a S3
 * con una URL prefirmada de `PUT` y después llama a `confirmar`, que es cuando
 * se guardan los metadatos. Es el patrón de `api/routes/acuerdos.js` y evita lo
 * que este módulo tiene prohibido: base64 dentro del ítem de DynamoDB, que se
 * come el límite de 400 KB por ítem y hace que un día una tarea falle al
 * guardar sin avisar antes.
 *
 * Tres comprobaciones que conviene no quitar:
 *
 * 1. **La clave de S3 la construye el servidor**, con un UUID propio y el
 *    nombre saneado. Si la eligiera el cliente, un `../` en el nombre colocaría
 *    el objeto fuera del prefijo de la tarea.
 * 2. **`confirmar` valida que la clave pertenece a esta tarea** antes de nada.
 *    Sin eso, cualquiera con una tarea propia registraría como adjunto suyo un
 *    objeto de otra tarea —o de otro módulo— y se lo descargaría con la URL
 *    firmada de lectura.
 * 3. **`confirmar` comprueba que el objeto existe de verdad** y toma de S3 el
 *    tamaño y el tipo. Fiarse de lo que declara el cliente deja listados con
 *    ficheros que no están y tamaños inventados.
 *
 * Ver `docs/tasks/03-contrato-api.md`, «Adjuntos».
 */

import crypto from 'crypto';
import path from 'path';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { docClient, tables } from '../db.js';
import { sanitizeUploadFileName } from '../uploadAllowlist.js';
import { PK, SK } from './tipos.js';
import { ACCIONES, registrarActividad } from './actividad.js';
import { cargarParaEscribir, cargarParaVer, salidaFilaHija } from './tareas.js';

const PREFIJO_S3 = process.env.TASKS_S3_PREFIX || 'tasks';

/** La subida caduca pronto: la URL es un permiso de escritura al bucket. */
const SEGUNDOS_SUBIDA = 300;
/** Lectura de una hora, como el resto del ERP. */
export const SEGUNDOS_LECTURA = 3600;

/** 25 MB. Un adjunto de tarea es un presupuesto o una foto, no un vídeo. */
export const MAX_BYTES_ADJUNTO = 25 * 1024 * 1024;

/**
 * Tipos admitidos y las extensiones que les corresponden.
 *
 * Se validan **las dos cosas**: el tipo declarado y la extensión del nombre.
 * Solo con el tipo, un `.html` subido como `application/pdf` se serviría desde
 * el bucket con la extensión que decide el navegador; solo con la extensión, el
 * `Content-Type` firmado no cuadraría con el contenido.
 */
export const TIPOS_ADJUNTO = Object.freeze({
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/gif': ['.gif'],
  'image/heic': ['.heic'],
  'text/plain': ['.txt'],
  'text/csv': ['.csv'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
});

// ─── Almacén inyectable ───

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-west-3' });
const S3_BUCKET = process.env.S3_BUCKET || 'igp-2.0-files';

/**
 * Salidas a S3 en un solo sitio, para poder sustituirlas en las pruebas.
 *
 * La URL de subida **no** firma `ServerSideEncryption`: firmarlo obliga al
 * navegador a mandar la cabecera `x-amz-server-side-encryption` en el `PUT`, y
 * si no la manda el `PUT` falla. El cifrado en reposo lo aplica el bucket por
 * defecto. Lo que sí lleva cifrado explícito es lo que sube el servidor (la
 * imagen capturada de un enlace).
 */
export const almacenAdjuntos = {
  urlSubida: ({ key, contentType }) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }), {
      expiresIn: SEGUNDOS_SUBIDA,
    }),
  urlLectura: ({ key }) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: SEGUNDOS_LECTURA }),
  /** Metadatos del objeto, o `null` si no está. */
  cabecera: async ({ key }) => {
    try {
      const r = await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return { tamano: Number(r.ContentLength) || 0, contentType: r.ContentType || '' };
    } catch (err) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  },
  borrar: async ({ key }) => {
    await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  },
};

/** Sustituye parte del almacén y devuelve la función que lo restaura. */
export function configurarAlmacenAdjuntos(parcial = {}) {
  const previo = { ...almacenAdjuntos };
  Object.assign(almacenAdjuntos, parcial);
  return () => Object.assign(almacenAdjuntos, previo);
}

// ─── Claves ───

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(valor) {
  return valor == null ? '' : String(valor).trim();
}

function autorDe(ctx) {
  return { id_usuario: texto(ctx?.idUsuario), Nombre: texto(ctx?.nombre) };
}

export function prefijoAdjuntos(idTarea) {
  return `${PREFIJO_S3}/tareas/${idTarea}/adjuntos/`;
}

/**
 * Clave del objeto: `<prefijo de la tarea>/<uuid>-<nombre saneado>`.
 *
 * El nombre pasa por `sanitizeUploadFileName`, que se queda con el nombre base
 * y descarta el resto: un `../../etc/passwd.pdf` acaba en `passwd.pdf` y no
 * puede salirse del prefijo. Reutiliza el saneado ya probado en
 * `api/tests/uploadAllowlist.test.mjs` en lugar de escribir otro.
 */
export function claveAdjunto(idTarea, idAdjunto, nombre) {
  return `${prefijoAdjuntos(idTarea)}${idAdjunto}-${sanitizeUploadFileName(nombre)}`;
}

/**
 * Descompone una clave y devuelve el id del adjunto, o `''` si la clave no es
 * de esta tarea. Es la comprobación que impide confirmar como propio un objeto
 * ajeno.
 */
export function idAdjuntoDeClave(idTarea, clave) {
  const k = texto(clave);
  const prefijo = prefijoAdjuntos(idTarea);
  if (!k.startsWith(prefijo)) return '';
  const resto = k.slice(prefijo.length);
  // Ni subcarpetas ni saltos de directorio: la clave la generó `claveAdjunto`.
  if (!resto || resto.includes('/') || resto.includes('..')) return '';
  const id = resto.slice(0, 36);
  if (!RE_UUID.test(id) || resto[36] !== '-') return '';
  return id;
}

// ─── Validación ───

/**
 * @returns {{ ok: true, contentType: string, nombre: string } | { ok: false, error: string }}
 */
export function validarAdjunto({ nombre, contentType, tamano }) {
  const nombreSaneado = sanitizeUploadFileName(nombre);
  if (!nombreSaneado || nombreSaneado === 'file') {
    return { ok: false, error: 'El adjunto necesita un nombre de fichero' };
  }

  const tipo = texto(contentType).toLowerCase();
  const extensiones = TIPOS_ADJUNTO[tipo];
  if (!extensiones) return { ok: false, error: `Tipo de archivo no permitido: «${tipo || 'sin tipo'}»` };

  const extension = path.extname(nombreSaneado).toLowerCase();
  if (!extensiones.includes(extension)) {
    return {
      ok: false,
      error: `La extensión «${extension || 'ninguna'}» no corresponde al tipo ${tipo}`,
    };
  }

  const bytes = Number(tamano);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return { ok: false, error: 'Indica el tamaño del fichero' };
  }
  if (bytes > MAX_BYTES_ADJUNTO) {
    return {
      ok: false,
      error: `El adjunto supera el máximo de ${Math.round(MAX_BYTES_ADJUNTO / (1024 * 1024))} MB`,
    };
  }

  return { ok: true, contentType: tipo, nombre: nombreSaneado };
}

// ─── Operaciones ───

/**
 * URL prefirmada de `PUT` para subir un adjunto.
 *
 * No escribe nada en DynamoDB: hasta que el objeto no está en S3 y se confirma,
 * el adjunto no existe. Así una subida abandonada no deja una fila apuntando a
 * un fichero que nunca llegó.
 *
 * @returns {Promise<{ ok: true, adjunto: object } | { ok: false, status: number, error: string }>}
 */
export async function presignarAdjunto({ ctx, idTarea, nombre, contentType, tamano } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes añadir adjuntos a esta tarea');
  if (!acceso.ok) return acceso;

  const validado = validarAdjunto({ nombre, contentType, tamano });
  if (!validado.ok) return { ok: false, status: 400, error: validado.error };

  const id = texto(idTarea);
  const idAdjunto = crypto.randomUUID();
  const key = claveAdjunto(id, idAdjunto, validado.nombre);
  const url = await almacenAdjuntos.urlSubida({ key, contentType: validado.contentType });

  return {
    ok: true,
    adjunto: {
      id_adjunto: idAdjunto,
      s3_key: key,
      nombre: validado.nombre,
      content_type: validado.contentType,
      upload_url: url,
      expira_en_seg: SEGUNDOS_SUBIDA,
    },
  };
}

/**
 * Confirma una subida: comprueba que el objeto está en S3 y guarda los
 * metadatos.
 *
 * El tamaño y el tipo se toman de S3, no del cuerpo de la petición: lo que
 * declara el cliente sirve para decidir si se firma la subida, no para
 * describir lo que acabó en el bucket.
 *
 * @returns {Promise<{ ok: true, adjunto: object } | { ok: false, status: number, error: string }>}
 */
export async function confirmarAdjunto({ ctx, idTarea, s3Key, nombre } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes añadir adjuntos a esta tarea');
  if (!acceso.ok) return acceso;

  const id = texto(idTarea);
  const clave = texto(s3Key);
  const idAdjunto = idAdjuntoDeClave(id, clave);
  if (!idAdjunto) {
    return { ok: false, status: 400, error: 'La ruta del fichero no corresponde a esta tarea' };
  }

  const cabecera = await almacenAdjuntos.cabecera({ key: clave });
  if (!cabecera) {
    // Sin objeto no hay adjunto: guardar la fila dejaría un listado con
    // ficheros que al pulsarlos dan error.
    return { ok: false, status: 409, error: 'El fichero no se ha subido todavía' };
  }
  if (cabecera.tamano > MAX_BYTES_ADJUNTO) {
    await almacenAdjuntos.borrar({ key: clave }).catch(() => {});
    return {
      ok: false,
      status: 400,
      error: `El adjunto supera el máximo de ${Math.round(MAX_BYTES_ADJUNTO / (1024 * 1024))} MB`,
    };
  }

  const autor = autorDe(ctx);
  // El nombre visible sale de la clave si no llega otro: es el que se saneó al
  // firmar la subida.
  const nombreFinal = sanitizeUploadFileName(texto(nombre) || clave.slice(prefijoAdjuntos(id).length + 37));
  const item = {
    PK: PK.tarea(id),
    SK: SK.adjunto(idAdjunto),
    id_adjunto: idAdjunto,
    nombre: nombreFinal,
    s3_key: clave,
    content_type: texto(cabecera.contentType),
    tamano: cabecera.tamano,
    subido_por: autor.id_usuario,
    subido_en: new Date().toISOString(),
  };
  await docClient.send(new PutCommand({ TableName: tables.tareas, Item: item }));

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.adjuntoAnadido,
    usuario: autor,
    detalle: { id_adjunto: idAdjunto, nombre: nombreFinal, tamano: item.tamano },
  });

  return { ok: true, adjunto: salidaFilaHija(item) };
}

async function leerAdjunto(idTarea, idAdjunto) {
  const r = await docClient.send(
    new GetCommand({
      TableName: tables.tareas,
      Key: { PK: PK.tarea(idTarea), SK: SK.adjunto(idAdjunto) },
    }),
  );
  return r.Item || null;
}

/**
 * URL firmada de lectura, válida una hora. Nunca se devuelve el contenido en el
 * cuerpo de la respuesta ni una URL pública del bucket.
 *
 * @returns {Promise<{ ok: true, url: string, expira_en_seg: number, adjunto: object } | { ok: false, status: number, error: string }>}
 */
export async function urlDeAdjunto({ ctx, idTarea, idAdjunto } = {}) {
  const acceso = await cargarParaVer(ctx, idTarea);
  if (!acceso.ok) return acceso;

  const adjunto = await leerAdjunto(texto(idTarea), texto(idAdjunto));
  if (!adjunto) return { ok: false, status: 404, error: 'El adjunto no existe' };

  const url = await almacenAdjuntos.urlLectura({ key: adjunto.s3_key });
  return { ok: true, url, expira_en_seg: SEGUNDOS_LECTURA, adjunto: salidaFilaHija(adjunto) };
}

/**
 * Borra el adjunto y su objeto en S3.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string }>}
 */
export async function borrarAdjunto({ ctx, idTarea, idAdjunto } = {}) {
  const acceso = await cargarParaEscribir(ctx, idTarea, undefined, 'No puedes borrar adjuntos de esta tarea');
  if (!acceso.ok) return acceso;

  const id = texto(idTarea);
  const adjunto = await leerAdjunto(id, texto(idAdjunto));
  if (!adjunto) return { ok: false, status: 404, error: 'El adjunto no existe' };

  try {
    await almacenAdjuntos.borrar({ key: adjunto.s3_key });
  } catch (err) {
    // Igual que en los enlaces: un objeto que no se puede borrar no debe dejar
    // en la tarea una fila que el usuario ya no puede quitar.
    console.error('[tasks/adjuntos] no se pudo borrar el objeto', adjunto.s3_key, err?.message || err);
  }

  await docClient.send(
    new DeleteCommand({
      TableName: tables.tareas,
      Key: { PK: PK.tarea(id), SK: SK.adjunto(adjunto.id_adjunto) },
    }),
  );

  await registrarActividad({
    tipo: 'tarea',
    entidadId: id,
    accion: ACCIONES.adjuntoBorrado,
    usuario: autorDe(ctx),
    detalle: { id_adjunto: adjunto.id_adjunto, nombre: texto(adjunto.nombre) },
  });

  return { ok: true };
}
