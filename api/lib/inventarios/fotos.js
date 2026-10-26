/**
 * Fotos dobles del conteo. El fichero va a S3; aquí solo quedan la clave y
 * los metadatos. No se escribe nada en Ágora.
 *
 * Cada par es `inventarios/<id>/fotos/<n>/frente-…` y `…/superior-…`.
 * Como máximo 6 pares. Un inventario importado no admite fotos.
 */

import crypto from 'crypto';
import { almacenAdjuntos, validarAdjunto } from '../tasks/adjuntos.js';
import {
  errorInventario,
  idSegmento,
  pkInventario,
  skFoto,
} from './claves.js';
import { obtenerInventario } from './inventarios.js';
import { borrarClave, poner, queryPk } from './store.js';

export const MAX_FOTOS_DOBLES = 6;
export const POSICIONES_FOTO = Object.freeze(['frente', 'superior']);

function numeroFoto(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FOTOS_DOBLES) {
    throw errorInventario(`La foto debe ser un número del 1 al ${MAX_FOTOS_DOBLES}`);
  }
  return n;
}

function posicionFoto(raw) {
  const p = String(raw ?? '').trim();
  if (!POSICIONES_FOTO.includes(p)) throw errorInventario('La posición debe ser frente o superior');
  return p;
}

function exigirFotos(inventario) {
  if (inventario.estado === 'importado') {
    throw errorInventario('El inventario importado no admite fotos', 409);
  }
  if (inventario.estado !== 'borrador' && inventario.estado !== 'contado') {
    throw errorInventario('El conteo ya no admite fotos', 403);
  }
}

function fotosDe(items) {
  return items.filter((it) => String(it.SK || '').startsWith('FOTO#'));
}

function numerosOcupados(fotos, numeroNuevo) {
  const nums = new Set(fotos.map((f) => Number(f.numero)).filter((n) => n >= 1));
  nums.add(numeroNuevo);
  return nums;
}

function prefijoClave(inventarioId, numero, posicion) {
  return `inventarios/${inventarioId}/fotos/${numero}/${posicion}-`;
}

function claveEsDeEstaFoto(inventarioId, numero, posicion, clave) {
  const k = String(clave ?? '');
  const prefijo = prefijoClave(inventarioId, numero, posicion);
  if (!k.startsWith(prefijo)) return false;
  const resto = k.slice(prefijo.length);
  return Boolean(resto) && !resto.includes('/') && !resto.includes('..');
}

async function cargarFotos(inventarioId) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const inventario = await obtenerInventario(id);
  const items = await queryPk(pkInventario(id));
  return { id, inventario, fotos: fotosDe(items) };
}

export async function prepararFoto({ inventarioId, numero, posicion, nombre, contentType, tamano }) {
  const { id, inventario, fotos } = await cargarFotos(inventarioId);
  exigirFotos(inventario);
  const n = numeroFoto(numero);
  const pos = posicionFoto(posicion);
  const validado = validarAdjunto({ nombre, contentType, tamano });
  if (!validado.ok) throw errorInventario(validado.error);
  if (!String(validado.contentType).startsWith('image/')) {
    throw errorInventario('La foto tiene que ser una imagen');
  }
  if (fotos.some((f) => Number(f.numero) === n && f.posicion === pos)) {
    throw errorInventario('Esa foto ya está subida', 409);
  }
  const ocupados = numerosOcupados(fotos, n);
  const yaEstaba = fotos.some((f) => Number(f.numero) === n);
  if (!yaEstaba && ocupados.size > MAX_FOTOS_DOBLES) {
    throw errorInventario(`Como máximo ${MAX_FOTOS_DOBLES} fotos`, 409);
  }
  const archivoId = crypto.randomUUID();
  const key = `${prefijoClave(id, n, pos)}${archivoId}-${validado.nombre}`;
  const url = await almacenAdjuntos.urlSubida({ key, contentType: validado.contentType });
  return {
    numero: n,
    posicion: pos,
    s3Key: key,
    nombre: validado.nombre,
    contentType: validado.contentType,
    uploadUrl: url,
  };
}

export async function confirmarFoto({ inventarioId, numero, posicion, s3Key }, usuario) {
  const { id, inventario, fotos } = await cargarFotos(inventarioId);
  exigirFotos(inventario);
  const n = numeroFoto(numero);
  const pos = posicionFoto(posicion);
  const clave = String(s3Key ?? '').trim();
  if (!claveEsDeEstaFoto(id, n, pos, clave)) {
    throw errorInventario('La ruta del fichero no corresponde a esta foto');
  }
  if (fotos.some((f) => Number(f.numero) === n && f.posicion === pos)) {
    throw errorInventario('Esa foto ya está subida', 409);
  }
  const cabecera = await almacenAdjuntos.cabecera({ key: clave });
  if (!cabecera) throw errorInventario('El fichero no se ha subido todavía', 409);
  if (!String(cabecera.contentType || '').startsWith('image/')) {
    await almacenAdjuntos.borrar({ key: clave }).catch(() => {});
    throw errorInventario('La foto tiene que ser una imagen');
  }
  const item = {
    PK: pkInventario(id),
    SK: skFoto(n, pos),
    numero: n,
    posicion: pos,
    s3Key: clave,
    contentType: String(cabecera.contentType || ''),
    tamano: Number(cabecera.tamano) || 0,
    subidoPor: usuario || '',
    subidoEn: new Date().toISOString(),
  };
  await poner(item, { crear: true });
  return presentar(item, null);
}

function presentar(item, url) {
  return {
    numero: Number(item.numero),
    posicion: item.posicion,
    contentType: item.contentType || '',
    tamano: Number(item.tamano) || 0,
    subidoEn: item.subidoEn || null,
    ...(url ? { url } : {}),
  };
}

export async function listarFotos(inventarioId) {
  const { fotos } = await cargarFotos(inventarioId);
  const salida = [];
  for (const foto of fotos) {
    let url = '';
    if (foto.s3Key) {
      url = await almacenAdjuntos.urlLectura({ key: foto.s3Key });
    }
    salida.push(presentar(foto, url));
  }
  salida.sort((a, b) => a.numero - b.numero || a.posicion.localeCompare(b.posicion, 'es'));
  return salida;
}

export async function borrarFoto({ inventarioId, numero, posicion }) {
  const { id, inventario, fotos } = await cargarFotos(inventarioId);
  exigirFotos(inventario);
  const n = numeroFoto(numero);
  const pos = posicionFoto(posicion);
  const foto = fotos.find((f) => Number(f.numero) === n && f.posicion === pos);
  if (!foto) throw errorInventario('La foto no existe', 404);
  if (foto.s3Key) await almacenAdjuntos.borrar({ key: foto.s3Key }).catch(() => {});
  await borrarClave(pkInventario(id), skFoto(n, pos));
  return { ok: true, numero: n, posicion: pos };
}
