/**
 * Lee un par de fotos (frente y desde arriba) y propone cantidades.
 * No escribe el stock real: la persona acepta la propuesta en el conteo.
 * No llama a Ágora y no manda el stock teórico al modelo.
 */

import { almacenAdjuntos } from '../tasks/adjuntos.js';
import { chatCompletion as chatOpenAi, iaDisponible } from '../ia/openaiClient.js';
import {
  errorInventario,
  idSegmento,
  pkInventario,
  skLectura,
} from './claves.js';
import { obtenerInventario } from './inventarios.js';
import { poner, queryPk } from './store.js';

const CONFIANZA_BAJA = 0.6;

let chatFn = chatOpenAi;

/** En pruebas se sustituye la llamada al modelo. Devuelve la función que restaura. */
export function configurarLecturaIa(fn) {
  const previa = chatFn;
  chatFn = fn || chatOpenAi;
  return () => { chatFn = previa; };
}

export function modeloInventario() {
  return process.env.IA_INVENTARIO_MODEL || 'gpt-4o';
}

function exigirLectura(inventario) {
  if (inventario.estado === 'importado') {
    throw errorInventario('El inventario importado no admite fotos', 409);
  }
  if (inventario.estado !== 'borrador' && inventario.estado !== 'contado') {
    throw errorInventario('El conteo ya no admite fotos', 403);
  }
}

function numeroDe(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 6) throw errorInventario('La foto debe ser un número del 1 al 6');
  return n;
}

function fotosDe(items) {
  return items.filter((it) => String(it.SK || '').startsWith('FOTO#'));
}

function lecturasDe(items) {
  return items
    .filter((it) => String(it.SK || '').startsWith('LECTURA#'))
    .sort((a, b) => Number(a.numero) - Number(b.numero));
}

function cantidadDe(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 10000) / 10000;
}

function confianzaDe(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function textoCorto(raw, respaldo) {
  const s = String(raw ?? '').trim().slice(0, 120);
  return s || respaldo;
}

function interpretar(texto, lineas) {
  let json;
  try {
    json = JSON.parse(String(texto || '').trim());
  } catch {
    throw errorInventario('La lectura no ha devuelto un conteo válido', 502);
  }
  const permitidos = new Map(lineas.map((l) => [String(l.productId), l.nombre || String(l.productId)]));
  const propuestas = new Map();
  const noIdentificados = [];

  for (const fila of Array.isArray(json?.propuestas) ? json.propuestas.slice(0, 40) : []) {
    const cantidad = cantidadDe(fila?.cantidad);
    if (cantidad == null) continue;
    const productId = String(fila?.productId ?? '').trim();
    if (!permitidos.has(productId)) {
      noIdentificados.push({
        descripcion: textoCorto(fila?.nombre, `Producto ${productId || 'sin id'} no está en el conteo`),
        cantidad,
      });
      continue;
    }
    const previa = propuestas.get(productId);
    propuestas.set(productId, {
      productId,
      cantidad: Math.round(((previa?.cantidad || 0) + cantidad) * 10000) / 10000,
      confianza: previa ? Math.min(previa.confianza, confianzaDe(fila?.confianza)) : confianzaDe(fila?.confianza),
    });
  }

  for (const fila of Array.isArray(json?.noIdentificados) ? json.noIdentificados.slice(0, 20) : []) {
    const cantidad = cantidadDe(fila?.cantidad);
    if (cantidad == null) continue;
    noIdentificados.push({
      descripcion: textoCorto(fila?.descripcion, 'No identificado'),
      cantidad,
    });
  }

  return {
    propuestas: [...propuestas.values()],
    noIdentificados,
  };
}

export function fusionarLecturas(lecturas) {
  const mapa = new Map();
  const noIdentificados = [];
  for (const lectura of lecturas || []) {
    if (lectura?.error) continue;
    for (const p of lectura.propuestas || []) {
      const previa = mapa.get(p.productId) || { productId: p.productId, cantidad: 0, fotos: 0, confianza: 1 };
      previa.cantidad = Math.round((previa.cantidad + Number(p.cantidad || 0)) * 10000) / 10000;
      previa.fotos += 1;
      previa.confianza = Math.min(previa.confianza, Number(p.confianza ?? 1));
      mapa.set(p.productId, previa);
    }
    for (const fila of lectura.noIdentificados || []) {
      noIdentificados.push({
        descripcion: fila.descripcion,
        cantidad: fila.cantidad,
        numero: Number(lectura.numero) || null,
      });
    }
  }
  const propuestas = [...mapa.values()].map((p) => ({
    productId: p.productId,
    cantidad: p.cantidad,
    fotos: p.fotos,
    confianza: p.confianza,
    aviso: p.fotos > 1 ? `visto en ${p.fotos} fotos, revisa` : null,
    baja: p.confianza < CONFIANZA_BAJA,
  }));
  return { propuestas, noIdentificados };
}

function presentarLectura(item) {
  return {
    numero: Number(item.numero),
    error: item.error || null,
    propuestas: item.propuestas || [],
    noIdentificados: item.noIdentificados || [],
  };
}

async function cargar(inventarioId) {
  const id = idSegmento(inventarioId, 'inventarioId');
  const inventario = await obtenerInventario(id);
  const items = await queryPk(pkInventario(id));
  return { id, inventario, items };
}

export async function listarLecturas(inventarioId) {
  const { inventario, items } = await cargar(inventarioId);
  exigirLectura(inventario);
  const lecturas = lecturasDe(items).map(presentarLectura);
  return { lecturas, ...fusionarLecturas(lecturas) };
}

export async function leerPar({ inventarioId, numero, reintentar = false }) {
  const { id, inventario, items } = await cargar(inventarioId);
  exigirLectura(inventario);
  const n = numeroDe(numero);
  const previa = items.find((it) => it.SK === skLectura(n));
  if (previa && !reintentar) return presentarLectura(previa);

  const fotos = fotosDe(items).filter((f) => Number(f.numero) === n);
  const frente = fotos.find((f) => f.posicion === 'frente');
  const superior = fotos.find((f) => f.posicion === 'superior');
  if (!frente?.s3Key || !superior?.s3Key) {
    throw errorInventario('Falta una de las dos fotos del par', 409);
  }
  if (!iaDisponible()) throw errorInventario('La lectura de fotos no está disponible', 503);

  const lineas = (inventario.lineas || []).map((l) => ({
    productId: String(l.productId),
    nombre: l.nombre || String(l.productId),
  }));
  const [urlFrente, urlSuperior] = await Promise.all([
    almacenAdjuntos.urlLectura({ key: frente.s3Key }),
    almacenAdjuntos.urlLectura({ key: superior.s3Key }),
  ]);

  let texto;
  let modelo = modeloInventario();
  try {
    const salida = await chatFn({
      system: [
        'Cuentas botellas de un inventario de hostelería a partir de dos fotos.',
        'La primera es de frente, para leer etiquetas. La segunda es desde arriba, para ver las de detrás.',
        'Solo puedes proponer productos de la lista. Si ves algo que no está, va a noIdentificados.',
        'La cantidad puede llevar decimales si hay una botella abierta (0.10, 0.25, 0.50, 0.75 o 0.90).',
        'confianza es un número de 0 a 1. No inventes productos de la lista que no veas.',
        'Responde solo JSON: {"propuestas":[{"productId":"","cantidad":0,"confianza":0}],"noIdentificados":[{"descripcion":"","cantidad":0}]}',
      ].join(' '),
      user: `Productos del conteo:\n${JSON.stringify(lineas)}`,
      imagenes: [{ url: urlFrente }, { url: urlSuperior }],
      model: modelo,
      temperature: 0.1,
      responseFormat: 'json_object',
      timeoutMs: 120000,
    });
    texto = salida.text;
    modelo = salida.model || modelo;
  } catch (err) {
    const item = {
      PK: pkInventario(id),
      SK: skLectura(n),
      numero: n,
      error: 'No se ha podido leer la foto',
      propuestas: [],
      noIdentificados: [],
      modelo,
      leidoEn: new Date().toISOString(),
    };
    await poner(item, previa && reintentar ? { exigir: false } : { crear: true });
    return presentarLectura(item);
  }

  let leido;
  try {
    leido = interpretar(texto, lineas);
  } catch {
    const fallida = {
      PK: pkInventario(id),
      SK: skLectura(n),
      numero: n,
      error: 'No se ha podido leer la foto',
      propuestas: [],
      noIdentificados: [],
      modelo,
      leidoEn: new Date().toISOString(),
    };
    await poner(fallida, previa && reintentar ? { exigir: false } : { crear: true });
    return presentarLectura(fallida);
  }
  const item = {
    PK: pkInventario(id),
    SK: skLectura(n),
    numero: n,
    propuestas: leido.propuestas,
    noIdentificados: leido.noIdentificados,
    modelo,
    leidoEn: new Date().toISOString(),
  };
  await poner(item, previa && reintentar ? { exigir: false } : { crear: true });
  return presentarLectura(item);
}
