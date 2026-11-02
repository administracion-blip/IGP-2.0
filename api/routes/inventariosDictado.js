/**
 * Dictado por voz del conteo de inventarios. Interpretar recibe el texto ya transcrito; /audio
 * recibe la grabación, la transcribe (lib/inventarios/dictado/transcripcion.js) y sigue el mismo
 * camino. El audio nunca se guarda: multer en memoria, sin S3, sin disco y sin logs del contenido.
 * IGP no escribe en Ágora (solo lee el teórico al añadir un producto, como POST /lineas).
 *
 * inventario.contar o inventario.gestionar (`ver`): sesión propia, interpretar, editar líneas,
 *   aplicar, deshacer una línea, pausar/reanudar/cerrar, leer formatos y alias, crear un formato.
 * inventario.gestionar: editar/borrar formatos y borrar alias.
 *
 * Rutas de un inventario: comprueban el almacén del inventario (permiteAlmacen) y las mismas
 * reglas de estado que guardarLinea (exigirConteo): importado → 409; quien solo cuenta, solo en
 * borrador/contado (403).
 *
 * Ninguna respuesta lleva stockTeorico: el dictado solo muestra lo contado.
 *
 * Decisiones:
 * - Candidatos del emparejamiento: solo las líneas de la plantilla de ESTE conteo. Un alias que
 *   apunta a un producto que no está en esa plantilla no se usa. Si no hay coincidencia, la IA
 *   propone uno de la plantilla (pendiente de confirmar); si tampoco, motivo 'no_en_plantilla'.
 *   Un único producto que contiene lo dicho se aplica solo, salvo ya contado, cálculo u otra
 *   regla de confirmación. Aprender un alias sigue exigiendo un producto activo del maestro.
 * - Formatos: primero se empareja el textoProducto con el matcher y, con ese productId, se busca
 *   su formato (obtenerFormatos) y se vuelve a parsear con resolverFormato. Las órdenes sin
 *   producto usan el de la última línea no descartada ni deshecha y, si les faltaba formato, se reinterpretan
 *   con el formato de ese producto.
 * - Modo: borrar → 'borrar'; reemplazar/corregir → 'reemplazar'; el resto → 'sumar' (sobre un
 *   producto sin contar es lo mismo que fijar el total).
 * - Todo cambio sobre un producto ya contado pide confirmación ('ya_contado'), también si lo contó
 *   una orden anterior del mismo dictado (se simula su previsión). Un producto con líneas sin
 *   aplicar en la sesión, o repetido en el dictado, pide 'repetido_en_dictado'.
 * - Excepción «sumado»: una suma sobre un producto que contó ESTE mismo dictado (mismo usuario y
 *   ciclo de sesión; un ciclo nuevo empieza al reanudar tras cerrar) se aplica sola: motivo
 *   informativo 'sumado' en vez de 'ya_contado'/'repetido_en_dictado' y `sumado: { antes, ahora }`.
 *   Cuenta si la versión de LINE# es la que dejó la última aplicación del producto en el ciclo, o
 *   si en este envío la línea anterior del producto también se aplica sola. Otros motivos
 *   (ambiguo, calculo, redondeo…) siguen pidiendo confirmar; aplicar.js lo recomprueba.
 * - Si lo que se guardará no cabe exacto en las fracciones de botella, 'redondeo' y el previsto
 *   muestra el valor real que se guardará.
 * - `idEnvio` (opcional, lo manda la UI por grabación) hace interpretar idempotente. En /audio es
 *   obligatorio y un envío ya procesado no se vuelve a transcribir.
 * - /audio: el servidor no mide la duración (sin dependencias); la UI corta a 60 s y aquí se
 *   limita el tamaño (perfil 'audio', 25 MB). Permisos, almacén y estado se comprueban antes de
 *   que multer lea el cuerpo. Una transcripción vacía, casi vacía o que es el propio prompt
 *   no crea líneas.
 * - «Multiplícalo por…» solo continúa si el texto empieza así y la línea anterior tiene
 *   menos de 20 s. Si la línea se queda sin producto, no hereda la cantidad.
 * - «sí», «no» y «el 10» resuelven la última línea pendiente de confirmar. «sí» la deja
 *   lista para aplicar (salvo redondeo o si falta el producto). «no» la descarta. «el 10»
 *   elige un candidato y, si sigue ya contado u otra regla, queda pendiente.
 */

import { Router } from 'express';
import { hasPermission, requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { exportStocks as exportStocksAgora } from '../lib/agora/client.js';
import { permiteAlmacen } from '../lib/alcanceAlmacenes.js';
import { responderError } from '../lib/http/responderError.js';
import { errorInventario, idSegmento } from '../lib/inventarios/claves.js';
import { stockContado } from '../lib/inventarios/diferencia.js';
import { exigirConteo, leerLineaConteo, obtenerInventario, versionLinea } from '../lib/inventarios/inventarios.js';
import { listarProductosInventario } from '../lib/inventarios/productos.js';
import { parsearDictado, partirCantidad } from '../lib/inventarios/dictado/parser.js';
import { emparejarProducto, filtrarCandidatosParecidos, normalizarAlias, prepararIndice } from '../lib/inventarios/dictado/matcher.js';
import { confirmarTrasElegir, motivosTrasElegir, resolverRespuesta } from '../lib/inventarios/dictado/respuestaVoz.js';
import { debeConsultarIa, esContinuacion, proponerInterpretacion } from '../lib/inventarios/dictado/interpretarIa.js';
import { aliasAceptable, borrarAlias, guardarAlias, listarAlias, sumarUso } from '../lib/inventarios/dictado/alias.js';
import {
  borrarFormato,
  crearFormato,
  editarFormato,
  obtenerFormatos,
} from '../lib/inventarios/dictado/formatos.js';
import {
  MAX_LINEAS_POR_ENVIO,
  actualizarLinea,
  anadirLineas,
  aplicadasDelCiclo,
  cerrarSesion,
  completarEnvio,
  idEnvioDe,
  leerLineaDictado,
  liberarEnvio,
  obtenerSesion,
  pausarSesion,
  reanudarSesion,
  reservarEnvio,
} from '../lib/inventarios/dictado/sesion.js';
import { aplicarLineasDictado, calcularResultado, deshacerLineaDictado } from '../lib/inventarios/dictado/aplicar.js';
import { transcribir } from '../lib/inventarios/dictado/transcripcion.js';
import { multerPerfil, rechazaArchivo } from '../lib/seguridad/subidas.js';

const MAX_TEXTO = 2000;
/** Tope de `textoProducto` al guardar la línea. Por encima, el parser no separó el trozo. */
const MAX_NOMBRE_PRODUCTO = 200;
const AVISO_SIN_SEPARAR = 'No he podido separar una parte del dictado. Haz una pausa de un segundo entre productos.';
const MAX_IDS_FORMATOS = 200;
const MAX_CANTIDAD = 100000;
const MAX_MOTIVOS = 20;
const VIAS_A_APRENDER = new Set(['aproximado', 'palabras']);

const AVISO_AUDIO_VACIO = 'No se ha entendido nada en el audio.';
/** La continuación («multiplícalo por») solo usa la línea anterior si es más reciente que esto. */
const CONTINUACION_MS = 20_000;

/**
 * Cierra la pregunta abierta. No crea otra línea.
 * @returns {Promise<{ lineas: object[], aviso?: string }>}
 */
async function cerrarConRespuesta(inventario, uid, nombre, pregunta, resp, conteo) {
  const n = pregunta.n;
  const id = inventario.inventarioId;
  if (resp.tipo === 'no') {
    const linea = await actualizarLinea(id, uid, n, { estado: 'descartada' }, nombre);
    return { lineas: [linea] };
  }
  if (resp.tipo === 'si') {
    const conCantidad = pregunta.modo === 'borrar'
      || (pregunta.cantidad != null && typeof pregunta.cantidad.total === 'number');
    if (!pregunta.productId || !conCantidad || (pregunta.motivos || []).includes('redondeo')) {
      return { lineas: [], aviso: 'Esa línea sigue pendiente: revísala en la pantalla.' };
    }
    // confirmada: aplicar acepta un ya contado solo si el usuario ya confirmó (el botón hace lo mismo).
    const linea = await actualizarLinea(id, uid, n, { confirmar: false, estado: 'confirmada' }, nombre);
    return { lineas: [linea] };
  }
  const yaContado = stockContado(conteo.get(resp.productId)) != null;
  const motivos = motivosTrasElegir(pregunta.motivos, { yaContado });
  const confirmar = confirmarTrasElegir({
    productId: resp.productId,
    modo: pregunta.modo,
    cantidad: pregunta.cantidad,
  }, motivos);
  const linea = await actualizarLinea(id, uid, n, {
    productId: resp.productId,
    productoNombre: resp.nombre,
    motivos,
    confirmar,
    estado: 'pendiente',
  }, nombre);
  return { lineas: [linea] };
}

function continuacionReciente(creadoEn, ahora = Date.now()) {
  const t = Date.parse(creadoEn || '');
  return Number.isFinite(t) && ahora - t >= 0 && ahora - t < CONTINUACION_MS;
}

const ver = requireAnyPermission('inventario.gestionar', 'inventario.contar');
const gestionar = requirePermission('inventario.gestionar');
const subirAudio = multerPerfil('audio').single('audio');

/** Igual que en routes/inventarios.js: lo que queda en actualizadoPor del inventario. */
function quien(req) {
  const email = req.user?.email || req.user?.sub || '';
  const nombre = String(req.user?.Nombre || '').trim();
  if (nombre && email && nombre !== email) return `${nombre} (${email})`;
  return email;
}

/** La sesión va por id de usuario (sub), nunca por email. */
function usuarioId(req) {
  const id = String(req.user?.sub ?? '').trim();
  if (!id) throw errorInventario('No autenticado', 401);
  return id;
}

function nombreSesion(req) {
  const nombre = String(req.user?.Nombre || '').trim() || req.user?.email || usuarioId(req);
  return String(nombre).slice(0, 120);
}

async function puedeGestionar(req) {
  if (req.isInternal || req.user?.rol === 'Administrador') return true;
  return hasPermission(req.user, 'inventario.gestionar');
}

function atrapar(res, err, mensaje) {
  return responderError(res, err, { mensaje, statusPorDefecto: 400 });
}

/**
 * Inventario de la ruta con almacén permitido y en estado de conteo para este usuario.
 * @returns {Promise<{ inventario: object, soloContar: boolean }|null>} null si ya respondió 403.
 */
async function inventarioDeRuta(req, res) {
  const inventario = await obtenerInventario(req.params.id);
  if (!(await permiteAlmacen(req, inventario.warehouseId))) {
    res.status(403).json({ error: 'Sin acceso a este almacén' });
    return null;
  }
  const soloContar = !(await puedeGestionar(req));
  exigirConteo(inventario, soloContar);
  return { inventario, soloContar };
}

const conteoDe = (linea) => ({
  stockReal: linea?.stockReal ?? null,
  botellasAbiertas: linea?.botellasAbiertas ?? 0,
  contado: stockContado(linea) != null,
});

/** Quita stockTeorico a cualquier profundidad. El dictado nunca lo muestra. */
function sinTeorico(valor) {
  if (Array.isArray(valor)) return valor.map(sinTeorico);
  if (!valor || typeof valor !== 'object') return valor;
  return Object.fromEntries(
    Object.entries(valor).filter(([k]) => k !== 'stockTeorico').map(([k, v]) => [k, sinTeorico(v)]),
  );
}

function sinRepetir(lista) {
  return [...new Set(lista)];
}

/**
 * Resultado previsto de aplicar la línea sobre lo contado ahora, con el mismo cálculo que
 * aplicar.js. `total` es lo que se GUARDARÁ (enteras + botella), no el total sin redondear.
 */
function previsto(modo, cantidad, lineaConteo) {
  if (modo === 'borrar') return { total: null, stockReal: null, botellasAbiertas: 0, redondeada: false };
  if (!cantidad || typeof cantidad.total !== 'number') return null;
  const r = calcularResultado(modo, cantidad, lineaConteo);
  if (r.negativo) return r;
  const total = Math.round((r.stockReal + r.botellasAbiertas) * 10000) / 10000;
  return { total, stockReal: r.stockReal, botellasAbiertas: r.botellasAbiertas, redondeada: r.redondeada };
}

/**
 * Productos candidatos del almacén del inventario: los activos de Igp_AgoraProducts. Ese maestro
 * es global (no hay catálogo por almacén), así que hoy es el mismo para todos los almacenes;
 * interpretar y el aprendizaje de alias usan esta única lista.
 */
function candidatosDelAlmacen(_inventario) {
  return listarProductosInventario({ todos: true });
}

/** Productos de la plantilla de este conteo: id y nombre. Sin stock. */
function plantillaDe(inventario) {
  return (inventario?.lineas || [])
    .filter((l) => l && l.productId && l.nombre)
    .map((l) => ({ productId: String(l.productId), nombre: String(l.nombre), activo: l.activo !== false }));
}

/** Lo que verá la línea de conteo si se aplica la previsión (para la siguiente orden del dictado). */
function conteoSimulado(lineaConteo, prev) {
  return { ...(lineaConteo || {}), stockReal: prev.stockReal, botellasAbiertas: prev.botellasAbiertas };
}

function modoDeOrden(tipo) {
  if (tipo === 'borrar') return 'borrar';
  if (tipo === 'reemplazar' || tipo === 'corregir') return 'reemplazar';
  return 'sumar';
}

// ─── Interpretar ───

/**
 * Con `idEnvio`, el mismo envío nunca crea líneas dos veces (reintento o dos peticiones a la
 * vez): se reserva DICTADO#<usuario>#ENVIO#<idEnvio> antes de crear nada y el repetido devuelve
 * las líneas que creó el primero, con `repetido: true`.
 */
async function interpretarUnaVez(req, inventario, texto, idEnvio) {
  return (await interpretarEnvio(req, inventario, idEnvio, () => texto)).resultado;
}

/**
 * Camino común de interpretar y /audio. `obtenerTexto` solo se llama si el envío es nuevo (un
 * idEnvio repetido no vuelve a transcribir). Texto vacío: no crea líneas y libera la reserva; un
 * error (también de transcripción) la libera para que el reintento con el mismo idEnvio funcione.
 * @returns {Promise<{ texto: string|null, resultado: { sesion: object|null, lineas: object[], repetido?: true } }>}
 *   `texto` es null en un repetido (el texto no se guarda).
 */
async function interpretarEnvio(req, inventario, idEnvio, obtenerTexto) {
  if (!idEnvio) {
    const texto = await obtenerTexto();
    return { texto, resultado: await interpretar(req, inventario, texto, null) };
  }
  const uid = usuarioId(req);
  const inventarioId = inventario.inventarioId;
  const reserva = await reservarEnvio(inventarioId, uid, idEnvio);
  if (!reserva.reservado) {
    const sesion = await obtenerSesion(inventarioId, uid);
    const ns = new Set(reserva.ns);
    return {
      texto: null,
      resultado: { sesion: sesion.meta, lineas: sesion.lineas.filter((l) => ns.has(l.n)), repetido: true },
    };
  }
  try {
    const texto = await obtenerTexto();
    if (!texto) {
      await liberarEnvio(inventarioId, uid, idEnvio);
      const sesion = await obtenerSesion(inventarioId, uid);
      return { texto: '', resultado: { sesion: sesion.meta, lineas: [] } };
    }
    const resultado = await interpretar(req, inventario, texto, idEnvio);
    await completarEnvio(inventarioId, uid, idEnvio, resultado.lineas.map((l) => l.n));
    return { texto, resultado };
  } catch (err) {
    await liberarEnvio(inventarioId, uid, idEnvio).catch(() => {});
    throw err;
  }
}

async function interpretar(req, inventario, texto, idEnvio) {
  const uid = usuarioId(req);
  const nombre = nombreSesion(req);
  const inventarioId = inventario.inventarioId;
  const [alias, previa, delCiclo] = await Promise.all([
    listarAlias(),
    obtenerSesion(inventarioId, uid),
    aplicadasDelCiclo(inventarioId, uid),
  ]);
  const plantilla = plantillaDe(inventario);
  const idsPlantilla = new Set(plantilla.map((p) => p.productId));
  const aliasEnPlantilla = alias.filter((a) => idsPlantilla.has(String(a.productId)));
  const indice = prepararIndice(plantilla, aliasEnPlantilla);
  const conteo = new Map((inventario.lineas || []).map((l) => [l.productId, l]));
  // Conteo tal como quedaría tras aplicar las órdenes anteriores de este mismo dictado.
  const simulado = new Map(conteo);
  // Productos con líneas sin aplicar de envíos anteriores de la sesión.
  const sinAplicar = new Set(previa.lineas
    .filter((l) => (l.estado === 'pendiente' || l.estado === 'confirmada') && l.productId)
    .map((l) => l.productId));
  // Productos ya vistos en este envío → si su última línea se aplica sola (confirmar=false).
  const enEnvio = new Map();
  // «Lo último que tocó LINE# fue este dictado (ciclo actual)»: versión de LINE# = la que dejó
  // su última aplicación. aplicar.js lo vuelve a comprobar con la LINE# que escribe.
  const memoTocadoPorCiclo = new Map();
  const tocadoPorEsteDictado = async (pid) => {
    if (!memoTocadoPorCiclo.has(pid)) {
      const ultima = delCiclo.ultimas.get(pid);
      const linea = ultima ? await leerLineaConteo(inventarioId, pid) : null;
      memoTocadoPorCiclo.set(pid, Boolean(ultima && linea && versionLinea(linea) === ultima.version));
    }
    return memoTocadoPorCiclo.get(pid);
  };
  const ultimaPrevia = [...previa.lineas].reverse()
    .find((l) => l.estado !== 'descartada' && l.estado !== 'deshecha') || null;
  if (ultimaPrevia && (ultimaPrevia.estado === 'pendiente' || ultimaPrevia.estado === 'confirmada') && ultimaPrevia.confirmar) {
    const ordenPregunta = ultimaPrevia.orden?.textoProducto
      ? ultimaPrevia.orden
      : { tipo: 'linea', textoProducto: ultimaPrevia.texto, cantidad: ultimaPrevia.cantidad || { total: 1 } };
    const empareje = emparejarProducto(ordenPregunta, { indice, plantilla });
    const candidatos = filtrarCandidatosParecidos(
      String(ultimaPrevia.texto || ordenPregunta.textoProducto || ''),
      empareje.candidatos || [],
    );
    const resp = resolverRespuesta(texto, { candidatos });
    if (resp) {
      const cerrada = await cerrarConRespuesta(inventario, uid, nombre, ultimaPrevia, resp, conteo);
      const sesionResp = await obtenerSesion(inventarioId, uid);
      return {
        sesion: sesionResp.meta,
        lineas: cerrada.lineas,
        ...(cerrada.aviso && { aviso: cerrada.aviso }),
      };
    }
  }

  const memoTexto = new Map();
  const pidDeTexto = (t) => {
    if (t == null) return null;
    if (!memoTexto.has(t)) {
      const m = emparejarProducto({ tipo: 'linea', textoProducto: t, cantidad: { total: 1 } }, { indice, plantilla });
      const ambiguo = m.motivos?.includes('marca_ambigua');
      memoTexto.set(t, ambiguo || m.productId == null ? null : String(m.productId));
    }
    return memoTexto.get(t);
  };

  // 1.ª pasada: qué productos piden formato («N cajas» sin «de M»).
  const implicados = new Set();
  parsearDictado(texto, {
    resolverFormato: (t) => {
      const pid = pidDeTexto(t);
      if (pid) implicados.add(pid);
      return null;
    },
  });
  const formatos = implicados.size ? await obtenerFormatos(implicados) : new Map();
  const formatoDe = (pid) => (pid ? formatos.get(pid) ?? null : null);
  const { ordenes } = parsearDictado(texto, { resolverFormato: (t) => formatoDe(pidDeTexto(t)) });

  const nuevas = [];
  let pendientes = [];
  let ultima = ultimaPrevia
    ? {
      productId: ultimaPrevia.productId,
      productoNombre: ultimaPrevia.productoNombre,
      pendiente: ultimaPrevia.confirmar !== false,
    }
    : null;
  let aviso = null;
  let textoAnterior = ultimaPrevia?.texto || null;
  let anteriorEn = ultimaPrevia?.creadoEn || null;
  const puedeContinuar = (orden) => esContinuacion(orden) && continuacionReciente(anteriorEn);

  const recortarNombre = (s) => (typeof s === 'string' && s.length > MAX_NOMBRE_PRODUCTO
    ? s.slice(0, MAX_NOMBRE_PRODUCTO).trim()
    : s);
  const ordenDemasiadoLarga = (o) => (o.textoProducto || '').length > MAX_NOMBRE_PRODUCTO
    || (o.alternativas || []).some((a) => (a?.textoProducto || '').length > MAX_NOMBRE_PRODUCTO);

  const volcar = async () => {
    for (let i = 0; i < pendientes.length; i += MAX_LINEAS_POR_ENVIO) {
      const lote = pendientes.slice(i, i + MAX_LINEAS_POR_ENVIO);
      const creadas = await anadirLineas(inventarioId, uid, lote.map((p) => p.datos), nombre);
      creadas.forEach((l, k) => nuevas.push({ ...l, ...lote[k].extra }));
    }
    pendientes = [];
  };

  const controlSesion = async (fn) => {
    try {
      await fn(inventarioId, uid);
    } catch (err) {
      if (err?.status !== 404) throw err;
    }
  };

  for (let orden of ordenes) {
    if (orden.tipo === 'pausa' || orden.tipo === 'sigue') {
      await volcar();
      await controlSesion(orden.tipo === 'pausa' ? pausarSesion : reanudarSesion);
      continue;
    }

    let productId = null;
    let productoNombre = null;
    let cantidad = orden.cantidad;
    let motivosMatch = [];
    let confirmarMatch = false;
    let via = null;
    let candidatos = [];
    // Un nombre de más de 200 caracteres tumba el trozo entero («textoProducto es demasiado
    // largo») y se pierden los conteos que sí se separaron. Se guarda la parte, sin emparejar,
    // para que no se aplique un producto a ciegas.
    let sinSeparar = false;
    if (ordenDemasiadoLarga(orden)) {
      aviso = AVISO_SIN_SEPARAR;
      sinSeparar = true;
      orden = {
        ...orden,
        textoProducto: recortarNombre(orden.textoProducto) || null,
        alternativas: (orden.alternativas || []).map((a) => ({
          ...a,
          textoProducto: recortarNombre(a?.textoProducto || '') || null,
        })),
        confirmar: true,
      };
    }

    if (sinSeparar) {
      motivosMatch = ['revisar_texto'];
      confirmarMatch = true;
    } else if (orden.textoProducto == null) {
      if (ultima?.productId) {
        productId = ultima.productId;
        productoNombre = ultima.productoNombre ?? null;
        if (ultima.pendiente) confirmarMatch = true;
        if (orden.calculo?.faltaFormato) {
          if (!formatos.has(productId)) {
            for (const [k, v] of await obtenerFormatos([productId])) formatos.set(k, v);
          }
          const f = formatoDe(productId);
          const [otra] = f ? parsearDictado(orden.textoOriginal, { resolverFormato: () => f }).ordenes : [];
          if (otra && otra.tipo === orden.tipo && otra.textoProducto == null) orden = otra;
          cantidad = orden.cantidad;
        }
      } else {
        motivosMatch = ['sin_producto'];
        confirmarMatch = true;
      }
    } else {
      const m = emparejarProducto(orden, { indice, plantilla });
      productId = m.productId == null ? null : String(m.productId);
      productoNombre = m.nombre;
      cantidad = m.lectura?.cantidad ?? orden.cantidad;
      motivosMatch = m.motivos;
      confirmarMatch = m.confirmar;
      via = m.via;
      candidatos = m.candidatos.map((c) => ({ productId: String(c.productId), nombre: c.nombre, puntuacion: c.puntuacion }));
    }

    let modoForzado = null;
    const motivosRegla = [...(orden.motivos || []), ...motivosMatch];
    const sigue = !sinSeparar && puedeContinuar(orden);
    if (!sinSeparar && debeConsultarIa({ orden, productId, motivos: motivosRegla, continuacion: sigue })) {
      const propuesta = await proponerInterpretacion({
        texto: String(orden.textoOriginal || orden.textoProducto || ''),
        anterior: sigue ? textoAnterior : null,
        productos: plantilla,
      });
      if (propuesta) {
        if (propuesta.productId) {
          productId = propuesta.productId;
          productoNombre = propuesta.nombre;
          const enLista = plantilla.find((p) => p.productId === productId);
          if (enLista && !candidatos.some((c) => c.productId === productId)) {
            candidatos = [{ productId, nombre: enLista.nombre, puntuacion: 0.5 }, ...candidatos].slice(0, 5);
          }
        }
        if (propuesta.cantidad != null && orden.tipo !== 'borrar' && productId) {
          cantidad = cantidadTotal(propuesta.cantidad);
        }
        if (propuesta.modo) modoForzado = propuesta.modo;
        motivosMatch = motivosMatch.filter((m) => m !== 'sin_coincidencia' && m !== 'no_en_plantilla');
        motivosMatch = [...motivosMatch, 'propuesto_ia'];
        confirmarMatch = true;
      }
    }
    if (!sinSeparar && !productId && orden.textoProducto && !motivosMatch.includes('marca_ambigua') && !motivosMatch.includes('propuesto_ia')) {
      motivosMatch = motivosMatch.filter((m) => m !== 'sin_coincidencia');
      if (!motivosMatch.includes('no_en_plantilla')) motivosMatch.push('no_en_plantilla');
      confirmarMatch = true;
    }
    if (!productId && esContinuacion(orden)) cantidad = null;
    candidatos = filtrarCandidatosParecidos(String(orden.textoOriginal || orden.textoProducto || ''), candidatos);

    const modo = modoForzado || modoDeOrden(orden.tipo);
    const lineaConteo = productId ? conteo.get(productId) : null;
    const lineaSimulada = productId ? simulado.get(productId) : null;
    const yaContado = stockContado(lineaSimulada) != null;
    const delEnvio = productId ? enEnvio.get(productId) : undefined;
    const repetido = Boolean(productId) && (sinAplicar.has(productId) || delEnvio !== undefined);
    let prev = productId ? previsto(modo, cantidad, lineaSimulada) : null;
    // «Sumado»: sumar sobre lo que contó este mismo dictado (ciclo actual) se aplica solo. En este
    // envío, si la línea anterior del producto se aplica sola; si no, si LINE# la dejó este dictado.
    // Sin líneas sin aplicar de envíos anteriores (esas siguen pidiendo confirmar).
    const sumado = yaContado && modo === 'sumar' && Boolean(prev) && !prev.negativo
      && !sinAplicar.has(productId)
      && (delEnvio !== undefined ? delEnvio.autoaplicable : await tocadoPorEsteDictado(productId));
    const motivos = [...orden.motivos, ...motivosMatch];
    if (sumado) {
      motivos.push('sumado');
    } else {
      if (yaContado) motivos.push('ya_contado');
      if (repetido) motivos.push('repetido_en_dictado');
    }
    if (prev?.negativo) {
      motivos.push('total_negativo');
      prev = null;
    }
    if (prev?.redondeada) motivos.push('redondeo');
    const unicos = sinRepetir(motivos).slice(0, MAX_MOTIVOS);
    const confirmar = orden.confirmar || confirmarMatch || (yaContado && !sumado) || !productId
      || unicos.some((m) => m !== 'sumado');
    if (productId) {
      enEnvio.set(productId, { autoaplicable: !confirmar });
      if (prev) simulado.set(productId, conteoSimulado(lineaSimulada, prev));
    }

    pendientes.push({
      datos: {
        texto: String(orden.textoOriginal || texto).slice(0, MAX_TEXTO),
        orden,
        productId,
        productoNombre,
        cantidad: cantidad ?? null,
        modo,
        motivos: unicos,
        confirmar,
        ...(idEnvio && { idEnvio }),
      },
      extra: {
        via,
        candidatos,
        conteoActual: productId ? conteoDe(lineaConteo) : null,
        enConteo: Boolean(lineaConteo),
        previsto: prev && { total: prev.total, stockReal: prev.stockReal, botellasAbiertas: prev.botellasAbiertas },
        ...(sumado && {
          sumado: {
            antes: { stockReal: lineaSimulada?.stockReal ?? null, botellasAbiertas: lineaSimulada?.botellasAbiertas ?? 0 },
            ahora: { stockReal: prev.stockReal, botellasAbiertas: prev.botellasAbiertas },
          },
        }),
        ...(orden.calculo?.faltaFormato && cantidad == null && { faltaFormato: { productId } }),
      },
    });
    if (!sinSeparar) ultima = { productId, productoNombre, pendiente: confirmar || !productId };
    textoAnterior = String(orden.textoOriginal || texto).slice(0, 500);
    anteriorEn = new Date().toISOString();
  }
  await volcar();
  const sesion = await obtenerSesion(inventarioId, uid);
  return { sesion: sesion.meta, lineas: nuevas, ...(aviso && { aviso }) };
}

// ─── Editar una línea ───

function cantidadTotal(raw) {
  if (raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
  if (typeof raw === 'boolean' || !Number.isFinite(n) || Math.abs(n) > MAX_CANTIDAD) {
    throw errorInventario('cantidad no válida.');
  }
  const total = Math.round(n * 10000) / 10000;
  const p = partirCantidad(total);
  return { total, stockReal: p.stockReal, botellasAbiertas: p.botellasAbiertas };
}

function numeroLinea(raw) {
  const s = String(raw ?? '');
  if (!/^\d{1,6}$/.test(s) || Number(s) < 1) throw errorInventario('Número de línea de dictado no válido.');
  return Number(s);
}

/**
 * Aprende alias al confirmar (no al aplicar). Solo hacia productos candidatos del almacén
 * (candidatosDelAlmacen, la misma lista que interpretar). Si ya existe al mismo producto, suma
 * un uso. Si no, se aprende cuando el usuario eligió otro producto que el emparejado o el
 * emparejamiento fue dudoso (aproximado, palabras, ambiguo o sin producto).
 * Quien solo cuenta crea alias nuevos y suma usos, pero no reasigna uno que ya apunta a OTRO
 * producto activo ('alias_existente'); con inventario.gestionar sí.
 */
async function aprenderAlias(req, previo, linea, activos, { soloContar }) {
  const textoProducto = previo.orden?.textoProducto ?? null;
  const norm = normalizarAlias(textoProducto);
  if (!textoProducto || !norm || !linea.productId) return { aliasAprendido: false, aliasMotivo: 'sin_texto' };
  const pid = String(linea.productId);
  const destino = (activos || []).find((p) => String(p.productId) === pid);
  if (!aliasAceptable(textoProducto, destino?.nombre || linea.productoNombre || '')) {
    return { aliasAprendido: false, aliasMotivo: 'alias_no_valido' };
  }
  const alias = await listarAlias();
  const existente = alias.find((a) => a.texto === norm);
  if (existente && String(existente.productId) === pid) {
    await sumarUso(textoProducto);
    return { aliasAprendido: false, aliasMotivo: 'ya_existia', aliasUsoSumado: true };
  }
  const auto = emparejarProducto(previo.orden, { indice: prepararIndice(activos, alias) });
  const autoPid = auto.productId == null ? null : String(auto.productId);
  const dudoso = autoPid == null || VIAS_A_APRENDER.has(auto.via) || auto.motivos.includes('ambiguo');
  if (autoPid === pid && !dudoso) return { aliasAprendido: false, aliasMotivo: 'no_necesario' };
  if (!activos.some((p) => p.productId === pid)) {
    return { aliasAprendido: false, aliasMotivo: 'producto_inactivo' };
  }
  if (existente && soloContar && activos.some((p) => p.productId === String(existente.productId))) {
    return { aliasAprendido: false, aliasMotivo: 'alias_existente' };
  }
  try {
    const a = await guardarAlias(textoProducto, pid, quien(req), { productosActivos: activos, noReasignar: soloContar });
    return { aliasAprendido: true, alias: { texto: a.texto, productId: a.productId, usos: a.usos } };
  } catch (err) {
    if (err?.code === 'alias_existente') return { aliasAprendido: false, aliasMotivo: 'alias_existente' };
    if (err?.code === 'alias_no_valido') return { aliasAprendido: false, aliasMotivo: 'alias_no_valido' };
    if (err?.status !== 400 && err?.status !== 409) throw err;
    req.log?.warn?.({ err }, '[dictado] alias no aprendido');
    return { aliasAprendido: false, aliasMotivo: 'conflicto' };
  }
}

async function editarLinea(req, inventario, n, body, { soloContar }) {
  const uid = usuarioId(req);
  const nombre = nombreSesion(req);
  const previo = await leerLineaDictado(inventario.inventarioId, uid, n);
  if (!previo) throw errorInventario('Línea de dictado no encontrada.', 404);
  const tiene = (campo) => Object.prototype.hasOwnProperty.call(body, campo);
  const cambios = {};
  let activos = null;
  const cargarActivos = async () => {
    activos ||= await candidatosDelAlmacen(inventario);
    return activos;
  };

  if (tiene('productId')) {
    if (body.productId == null || body.productId === '') {
      cambios.productId = null;
      cambios.productoNombre = null;
    } else {
      const pid = idSegmento(body.productId, 'productId');
      const activo = (await cargarActivos()).find((p) => p.productId === pid);
      const enConteo = (inventario.lineas || []).find((l) => l.productId === pid);
      if (!activo && !enConteo) throw errorInventario('Producto no encontrado', 404);
      cambios.productId = pid;
      cambios.productoNombre = (activo || enConteo).nombre || pid;
    }
  }
  if (tiene('cantidad')) cambios.cantidad = cantidadTotal(body.cantidad);
  if (tiene('modo')) cambios.modo = body.modo;
  if (tiene('estado')) {
    if (!['confirmada', 'descartada', 'pendiente'].includes(body.estado)) {
      throw errorInventario('estado no válido: confirmada, descartada o pendiente.');
    }
    cambios.estado = body.estado;
  }

  const estadoFinal = cambios.estado ?? previo.estado;
  const final = {
    productId: tiene('productId') ? cambios.productId : previo.productId,
    cantidad: tiene('cantidad') ? cambios.cantidad : previo.cantidad,
    modo: tiene('modo') ? cambios.modo : previo.modo,
  };
  if (estadoFinal === 'confirmada') {
    if (!final.productId) throw errorInventario('Elige un producto antes de confirmar.');
    if (!final.modo) throw errorInventario('Falta el modo de la línea.');
    if (final.modo !== 'borrar' && final.cantidad == null) throw errorInventario('Falta la cantidad.');
    if (final.modo === 'reemplazar' && final.cantidad.total < 0) {
      throw errorInventario('La cantidad no puede ser negativa.');
    }
  }
  const editado = tiene('productId') || tiene('cantidad') || tiene('modo');
  if (editado && estadoFinal === 'pendiente') cambios.confirmar = true;

  const lineaConteo = final.productId ? (inventario.lineas || []).find((l) => l.productId === final.productId) : null;
  const prev = final.productId && final.modo ? previsto(final.modo, final.cantidad, lineaConteo) : null;
  if (editado && prev?.redondeada) {
    // Lo que se guardará no es lo tecleado: la línea queda pendiente de una confirmación aparte.
    if (estadoFinal === 'confirmada') {
      throw Object.assign(errorInventario(
        `La cantidad se guardará como ${prev.stockReal} + ${prev.botellasAbiertas}: revísala y confirma.`,
      ), { code: 'redondeo' });
    }
    cambios.confirmar = true;
    cambios.motivos = sinRepetir([...(Array.isArray(previo.motivos) ? previo.motivos : []), 'redondeo'])
      .slice(0, MAX_MOTIVOS);
  }

  const linea = await actualizarLinea(inventario.inventarioId, uid, n, cambios, nombre);
  let alias = {};
  if (linea.estado === 'confirmada' && previo.estado !== 'confirmada') {
    alias = await aprenderAlias(req, previo, linea, await cargarActivos(), { soloContar });
  }
  const previstoVisible = prev && !prev.negativo
    ? { total: prev.total, stockReal: prev.stockReal, botellasAbiertas: prev.botellasAbiertas }
    : null;
  return { linea, previsto: previstoVisible, ...alias };
}

// ─── Audio ───

/**
 * Un audio en curso por usuario (req.user.sub) para acotar la memoria: hasta 25 MB por petición.
 * Es POR PROCESO (Map en memoria): con varias instancias del API, cada una lleva la suya.
 * usuario → testigo de la petición que lo tiene, para que una petición vieja no suelte el de otra.
 */
const audiosEnCurso = new Map();

function liberarAudio(req) {
  const t = req.testigoAudio;
  if (t && audiosEnCurso.get(t.usuario) === t) audiosEnCurso.delete(t.usuario);
}

/**
 * Antes de multer (no se lee el cuerpo si ya hay otro). Se libera en el finally del handler; si
 * la petición no llega al handler (403, error de multer, cliente que corta), al cerrarse la
 * respuesta. Mientras el handler procesa, cortar la conexión no lo libera: el audio sigue en uso.
 */
function unAudioPorUsuario(req, res, next) {
  const usuario = String(req.user?.sub ?? '').trim() || 'interno';
  if (audiosEnCurso.has(usuario)) {
    return res.status(429).json({ error: 'Ya se está procesando otro audio. Espera a que termine.' });
  }
  const testigo = { usuario, procesando: false };
  audiosEnCurso.set(usuario, testigo);
  req.testigoAudio = testigo;
  res.once('close', () => {
    if (!testigo.procesando) liberarAudio(req);
  });
  return next();
}

/** Almacén y estado ANTES de multer: sin acceso no se acepta el cuerpo (hasta 25 MB). */
async function contextoAudio(req, res, next) {
  try {
    const ctx = await inventarioDeRuta(req, res);
    if (!ctx) {
      liberarAudio(req);
      return undefined;
    }
    req.dictadoCtx = ctx;
    return next();
  } catch (err) {
    liberarAudio(req);
    return atrapar(res, err, 'Error transcribiendo el dictado');
  }
}

const MENSAJES_MULTER_AUDIO = {
  LIMIT_FILE_SIZE: 'El audio supera el tamaño máximo (25 MB).',
  LIMIT_PART_COUNT: 'Demasiadas partes en el envío: manda solo el audio y el idEnvio.',
  LIMIT_FIELD_COUNT: 'Demasiados campos en el envío: manda solo el audio y el idEnvio.',
  LIMIT_FIELD_VALUE: 'Un campo del envío es demasiado largo.',
};

/** multer en memoria (perfil 'audio'); sus errores, en 400 como el errorHandler global. */
function recibirAudio(req, res, next) {
  subirAudio(req, res, (err) => {
    if (!err) return next();
    req.file = undefined;
    liberarAudio(req);
    req.log?.warn?.({ code: err.code, name: err.name }, '[dictado] audio rechazado por multer');
    const mensaje = MENSAJES_MULTER_AUDIO[err.code] || 'Envía un único audio en el campo «audio».';
    return res.status(400).json({ error: mensaje });
  });
}

// ─── Router ───

/** `exportStocks` se inyecta para las pruebas; en producción es el cliente de Ágora (solo lectura). */
export function crearRouterDictado({ exportStocks = exportStocksAgora } = {}) {
  const router = Router();

  // Solo las rutas del dictado: el resto de /inventarios sigue con su respuesta intacta.
  router.use(['/inventarios/dictado', '/inventarios/:id/dictado'], (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => json(sinTeorico(body));
    next();
  });

  router.get('/inventarios/dictado/formatos', ver, async (req, res) => {
    try {
      const ids = sinRepetir(String(req.query.productIds ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      if (ids.length > MAX_IDS_FORMATOS) {
        return res.status(400).json({ error: `Como máximo ${MAX_IDS_FORMATOS} productos.` });
      }
      const mapa = await obtenerFormatos(ids);
      return res.json({ formatos: [...mapa.entries()].map(([productId, f]) => ({ productId, ...f })) });
    } catch (err) {
      return atrapar(res, err, 'Error leyendo los formatos');
    }
  });

  router.post('/inventarios/dictado/formatos', ver, async (req, res) => {
    try {
      const formato = await crearFormato(req.body?.productId, {
        unidadesCaja: req.body?.unidadesCaja,
        unidadesPack: req.body?.unidadesPack,
      }, quien(req));
      return res.status(201).json(formato);
    } catch (err) {
      return atrapar(res, err, 'Error creando el formato');
    }
  });

  router.put('/inventarios/dictado/formatos/:productId', gestionar, async (req, res) => {
    try {
      const formato = await editarFormato(req.params.productId, {
        unidadesCaja: req.body?.unidadesCaja,
        unidadesPack: req.body?.unidadesPack,
      }, quien(req));
      return res.json(formato);
    } catch (err) {
      return atrapar(res, err, 'Error editando el formato');
    }
  });

  router.delete('/inventarios/dictado/formatos/:productId', gestionar, async (req, res) => {
    try {
      return res.json(await borrarFormato(req.params.productId));
    } catch (err) {
      return atrapar(res, err, 'Error borrando el formato');
    }
  });

  router.get('/inventarios/dictado/alias', ver, async (req, res) => {
    try {
      return res.json({ alias: await listarAlias() });
    } catch (err) {
      return atrapar(res, err, 'Error listando los alias');
    }
  });

  router.delete('/inventarios/dictado/alias/:texto', gestionar, async (req, res) => {
    try {
      return res.json(await borrarAlias(req.params.texto));
    } catch (err) {
      return atrapar(res, err, 'Error borrando el alias');
    }
  });

  // Pendiente de decisión de producto: como las demás rutas del inventario, aplica exigirConteo,
  // así que quien solo cuenta no lee su sesión con el inventario revisado (403) y nadie la lee
  // con el inventario importado (409).
  router.get('/inventarios/:id/dictado', ver, async (req, res) => {
    try {
      const ctx = await inventarioDeRuta(req, res);
      if (!ctx) return;
      const sesion = await obtenerSesion(ctx.inventario.inventarioId, usuarioId(req));
      return res.json({ sesion: sesion.meta, lineas: sesion.lineas });
    } catch (err) {
      return atrapar(res, err, 'Error leyendo el dictado');
    }
  });

  router.post('/inventarios/:id/dictado/interpretar', ver, async (req, res) => {
    try {
      const texto = req.body?.texto;
      if (typeof texto !== 'string' || !texto.trim()) {
        return res.status(400).json({ error: 'texto es obligatorio' });
      }
      if (texto.length > MAX_TEXTO) return res.status(400).json({ error: 'El dictado es demasiado largo.' });
      const idEnvio = idEnvioDe(req.body?.idEnvio);
      const ctx = await inventarioDeRuta(req, res);
      if (!ctx) return;
      const resultado = await interpretarUnaVez(req, ctx.inventario, texto, idEnvio);
      const status = resultado.repetido || resultado.lineas.length === 0 ? 200 : 201;
      return res.status(status).json(resultado);
    } catch (err) {
      return atrapar(res, err, 'Error interpretando el dictado');
    }
  });

  // multipart: `audio` (un fichero) e `idEnvio` (obligatorio). Respuesta { texto, sesion, lineas,
  // repetido? }; un repetido no transcribe y devuelve texto null.
  // Para la UI (fase 6): la transcripción puede tardar hasta 60 s más la interpretación, así que
  // apiFetch debe usar timeoutMs >= 90000. Un 409 con el mismo idEnvio significa «se está
  // procesando»: reintentar más tarde con el MISMO idEnvio, sin crear otro. 429: ya hay otro audio
  // de este usuario en curso.
  router.post('/inventarios/:id/dictado/audio', ver, unAudioPorUsuario, contextoAudio, recibirAudio, async (req, res) => {
    const file = req.file;
    req.file = undefined;
    if (req.testigoAudio) req.testigoAudio.procesando = true;
    try {
      if (!file) return res.status(400).json({ error: 'Falta el audio (campo «audio»).' });
      if (rechazaArchivo(res, file, 'audio')) return undefined;
      const idEnvio = idEnvioDe(req.body?.idEnvio);
      if (!idEnvio) return res.status(400).json({ error: 'idEnvio es obligatorio' });
      const { inventario } = req.dictadoCtx;
      const { texto, resultado } = await interpretarEnvio(req, inventario, idEnvio, async () => {
        const productos = plantillaDe(inventario);
        const ids = new Set(productos.map((p) => p.productId));
        const alias = (await listarAlias()).filter((a) => ids.has(String(a.productId)));
        return transcribir(file, { productos, alias });
      });
      if (resultado.repetido) return res.status(200).json({ texto, ...resultado });
      if (!texto) return res.status(200).json({ texto, ...resultado, aviso: AVISO_AUDIO_VACIO });
      return res.status(resultado.lineas.length === 0 ? 200 : 201).json({ texto, ...resultado });
    } catch (err) {
      return atrapar(res, err, 'Error transcribiendo el dictado');
    } finally {
      if (file) file.buffer = null;
      liberarAudio(req);
    }
  });

  router.patch('/inventarios/:id/dictado/lineas/:n', ver, async (req, res) => {
    try {
      const n = numeroLinea(req.params.n);
      const ctx = await inventarioDeRuta(req, res);
      if (!ctx) return;
      return res.json(await editarLinea(req, ctx.inventario, n, req.body || {}, { soloContar: ctx.soloContar }));
    } catch (err) {
      return atrapar(res, err, 'Error actualizando la línea del dictado');
    }
  });

  router.post('/inventarios/:id/dictado/aplicar', ver, async (req, res) => {
    try {
      const ctx = await inventarioDeRuta(req, res);
      if (!ctx) return;
      const uid = usuarioId(req);
      const resultado = await aplicarLineasDictado({
        inventarioId: ctx.inventario.inventarioId,
        usuarioId: uid,
        quien: quien(req),
        quienSesion: nombreSesion(req),
        lineas: req.body?.lineas,
        soloContar: ctx.soloContar,
        exportStocks,
        inventario: ctx.inventario,
      });
      const sesion = await obtenerSesion(ctx.inventario.inventarioId, uid);
      return res.json({ ...resultado, sesion: sesion.meta, lineasDictado: sesion.lineas });
    } catch (err) {
      return atrapar(res, err, 'Error aplicando el dictado');
    }
  });

  // «Deshacer último»: pendiente/confirmada → descartada; aplicada → restaura el conteo y queda
  // 'deshecha' (409 si el producto se cambió después). Idempotente: yaDeshecha.
  router.post('/inventarios/:id/dictado/lineas/:n/deshacer', ver, async (req, res) => {
    try {
      const n = numeroLinea(req.params.n);
      const ctx = await inventarioDeRuta(req, res);
      if (!ctx) return;
      return res.json(await deshacerLineaDictado({
        inventarioId: ctx.inventario.inventarioId,
        usuarioId: usuarioId(req),
        quien: quien(req),
        quienSesion: nombreSesion(req),
        n,
        soloContar: ctx.soloContar,
        inventario: ctx.inventario,
      }));
    } catch (err) {
      return atrapar(res, err, 'Error deshaciendo la línea del dictado');
    }
  });

  for (const [accion, fn] of [['pausar', pausarSesion], ['reanudar', reanudarSesion], ['cerrar', cerrarSesion]]) {
    router.post(`/inventarios/:id/dictado/${accion}`, ver, async (req, res) => {
      try {
        const ctx = await inventarioDeRuta(req, res);
        if (!ctx) return;
        return res.json({ sesion: await fn(ctx.inventario.inventarioId, usuarioId(req)) });
      } catch (err) {
        return atrapar(res, err, 'Error cambiando el estado del dictado');
      }
    });
  }

  return router;
}

export default crearRouterDictado();
