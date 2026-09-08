/**
 * Reglas de negocio de activos (Fase 1). Validación en servidor.
 */

import {
  DIGITOS_CORRELATIVO_DEFAULT,
  ESTADO,
  ESTADOS_ACTIVO,
  EVENTO,
  FORMATOS_ETIQUETA,
  FOTOS_MAX,
  GRANULARIDAD,
  GSI_LISTADO_ACTIVO,
  GSI_LISTADO_CAT,
  GSI_LISTADO_MOD,
  GSI_LISTADO_PLANT,
  LOTE_MAX_UNIDADES,
  PREFIJO_PLANT,
  SK_META,
  TIPOS_FOTO,
  TRANSICIONES,
  enLista,
  errorHttp,
} from './tipos.js';
import {
  esUuid,
  formatearEtiqueta,
  normalizarPrefijo,
  normalizarSerie,
  nuevoId,
  parsearEtiqueta,
  prefijoValido,
} from './ids.js';
import { asegurarLocalAccesible, idLocalNorm, idsLocalesPermitidos } from './locales.js';
import {
  buscarLoteAsignado,
  buscarLoteEnLocal,
  buscarPorEtiqueta,
  buscarPorSerie,
  claveEstadoCatEtiqueta,
  contarModelosActivosDeCategoria,
  getActivo,
  getCategoria,
  getModelo,
  getPlantilla,
  hayActivosDeModelo,
  itemEvento,
  listarActivosDeModelo,
  listarActivosGlobal,
  listarActivosPorLocal,
  listarAsignados,
  listarCategorias,
  listarEventos,
  listarModelos,
  listarPendientesVerificacion,
  listarPlantillas,
  prefijoCategoriaEnUso,
  sumarDisponiblePorModelo,
  putActivoNuevo,
  putCategoria,
  putEvento,
  putModelo,
  putPlantilla,
  reservarCorrelativo,
  updateActivo,
  updateCategoria,
  updateModelo,
  updatePlantilla,
} from './store.js';
import { docClient, tables } from '../db.js';
import { getEmployeeById } from '../dynamo/personalEmployees.js';
import {
  borrarObjeto,
  clavePerteneceAlActivo,
  clavePerteneceAlModelo,
  presignarSubida,
  presignarSubidaModelo,
  urlFirmadaLectura,
  urlsFirmadasDeFotos,
} from './s3.js';
import { CUERPO_PLANTILLA_DEFAULT, DATOS_PREVIEW_PLANTILLA, renderCuerpoPlantilla, sanitizarHtmlPlantilla } from './plantillaTexto.js';
import { lineasDisponibles, tallasDesdeMapa, unidadesDe } from './stockDisponible.js';
import { agruparCustodiaPorArticulo } from './custodiaArticulos.js';

function texto(v) {
  return v == null ? '' : String(v).trim();
}

function ahora() {
  return new Date().toISOString();
}

function actorDe(user) {
  return {
    id: texto(user?.sub || user?.id_usuario),
    nombre: texto(user?.nombre || user?.Nombre || user?.email),
    email: texto(user?.email),
  };
}

function atributosNorm(atributos) {
  if (!atributos || typeof atributos !== 'object' || Array.isArray(atributos)) return '{}';
  const keys = Object.keys(atributos).sort();
  const o = {};
  for (const k of keys) {
    const v = atributos[k];
    if (v == null || v === '') continue;
    o[k] = typeof v === 'string' ? v.trim() : v;
  }
  return JSON.stringify(o);
}

function parseAtributos(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = texto(k);
    if (!key) continue;
    o[key] = typeof v === 'string' ? v.trim() : v;
  }
  return o;
}

function atributosSegunSchema(modelo, raw) {
  const attrs = parseAtributos(raw);
  const schema = Array.isArray(modelo?.atributos_schema) ? modelo.atributos_schema : [];
  const tallaSchema = schema.find((s) => texto(s?.clave) === 'talla');
  if (!tallaSchema || modelo.es_serializable === true) return attrs;
  const talla = texto(attrs.talla);
  if (!talla) throw errorHttp(400, 'Indica la talla');
  const opciones = Array.isArray(tallaSchema.opciones)
    ? tallaSchema.opciones.map((o) => texto(o)).filter(Boolean)
    : [];
  if (opciones.length && !opciones.includes(talla)) throw errorHttp(400, 'Talla no válida');
  return { ...attrs, talla };
}

function numeroOpcional(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function flagsGsiActivo(item) {
  const out = {
    gsi_estado_cat_etiqueta: claveEstadoCatEtiqueta(item.estado, item.categoria_id, item.etiqueta_legible),
  };
  if (item.estado !== ESTADO.baja) out.gsi_listado = GSI_LISTADO_ACTIVO;
  return out;
}

function publicActivo(item, urlsFotos = null) {
  if (!item) return null;
  const {
    gsi_estado_cat_etiqueta: _g,
    gsi_listado: _l,
    ...resto
  } = item;
  const fotos = (item.fotos || []).map((f) => ({
    foto_id: f.foto_id,
    tipo: f.tipo,
    creado_en: f.creado_en,
    url: urlsFotos ? urlsFotos[f.foto_id] || null : undefined,
  }));
  if (!urlsFotos) {
    for (const f of fotos) delete f.url;
  }
  return {
    ...resto,
    local_imputado_id: resto.local_imputado_id ?? null,
    local_imputado_nombre: resto.local_imputado_nombre ?? null,
    fotos,
  };
}

function fotoGeneralDe(item) {
  const fotos = Array.isArray(item?.fotos) ? item.fotos : [];
  return fotos.find((f) => f.tipo === 'general' && f.s3_key) || fotos.find((f) => f.s3_key) || null;
}

async function clavesFotoModelo(modeloIds) {
  const uniq = [...new Set((modeloIds || []).filter(Boolean))];
  const map = new Map();
  await Promise.all(
    uniq.map(async (id) => {
      const m = await getModelo(id);
      if (m?.foto_s3_key) map.set(id, m.foto_s3_key);
    }),
  );
  return map;
}

async function publicActivoListado(item, fotoModeloKey = null) {
  const pub = publicActivo(item);
  const foto = fotoGeneralDe(item);
  const key = foto?.s3_key || fotoModeloKey || null;
  const foto_url = key ? await urlFirmadaLectura(key) : null;
  const { fotos: _fotos, ...resto } = pub;
  return { ...resto, foto_url };
}

async function publicActivosListado(items) {
  const lista = items || [];
  const mapa = await clavesFotoModelo(lista.map((it) => it.modelo_id));
  return Promise.all(lista.map((it) => publicActivoListado(it, mapa.get(it.modelo_id) || null)));
}

function publicCatalogo(item) {
  if (!item) return null;
  const { PK: _pk, SK: _sk, gsi_listado: _g, foto_s3_key: _k, ...resto } = item;
  return resto;
}

async function publicCatalogoConFoto(item) {
  const pub = publicCatalogo(item);
  if (!pub) return null;
  const foto_url = item?.foto_s3_key ? await urlFirmadaLectura(item.foto_s3_key) : null;
  return { ...pub, foto_url };
}

function publicEvento(item) {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...resto } = item;
  return resto;
}

async function exigirActivoVisible(user, assetId) {
  if (!esUuid(assetId)) throw errorHttp(400, 'Identificador de activo no válido');
  const item = await getActivo(assetId);
  if (!item) throw errorHttp(404, 'Este QR no corresponde a ningún activo. Comprueba que la etiqueta sea de IGP.', 'DESCONOCIDO');
  await asegurarLocalAccesible(user, item.id_local);
  return item;
}

function construirActivo({
  assetId,
  etiqueta,
  categoria,
  modelo,
  local,
  granularidad,
  cantidad,
  numeroSerie,
  atributos,
  estado,
  coste,
  fechaCompra,
  notas,
  actor,
  custodio = null,
  imputado = null,
}) {
  const creadoEn = ahora();
  const serie = normalizarSerie(numeroSerie);
  const attrs = parseAtributos(atributos);
  const base = {
    asset_id: assetId,
    etiqueta_legible: etiqueta,
    prefijo_etiqueta: categoria.prefijo_etiqueta,
    categoria_id: categoria.categoria_id,
    modelo_id: modelo.modelo_id,
    marca: modelo.marca,
    nombre_modelo: modelo.nombre,
    granularidad,
    numero_serie: serie || null,
    cantidad,
    atributos: attrs,
    atributos_norm: atributosNorm(attrs),
    estado,
    id_local: local.id_local,
    local_nombre: local.local_nombre,
    empresa_id: local.empresa_id,
    coste_adquisicion: coste,
    fecha_compra: fechaCompra || null,
    notas: texto(notas) || null,
    fotos: [],
    etiqueta_impresa: false,
    etiqueta_impresa_en: null,
    etiqueta_verificada: false,
    etiqueta_verificada_en: null,
    etiqueta_verificada_por: null,
    custodio_id: custodio?.id || null,
    custodio_tipo: custodio?.id ? 'personal' : null,
    custodio_nombre: custodio?.nombre || null,
    asignado_en: custodio?.id ? ahora() : null,
    local_imputado_id: imputado?.id_local || null,
    local_imputado_nombre: imputado?.local_nombre || null,
    creado_en: creadoEn,
    actualizado_en: creadoEn,
    creado_por: actor.id,
  };
  if (serie) base.numero_serie_norm = serie;
  Object.assign(base, flagsGsiActivo(base));
  return base;
}

/**
 * 1) ADD atómico del correlativo (así se conoce el número para la etiqueta).
 * 2) Put del activo y del evento.
 * Si 2 falla, ese número queda hueco a propósito: las etiquetas no se reciclan.
 */
async function persistirAlta(activo, evento) {
  await putActivoNuevo(activo);
  await putEvento(evento);
  return activo;
}

// ─── Catálogo ───

export async function crearCategoria(user, body) {
  const nombre = texto(body?.nombre);
  const prefijo = normalizarPrefijo(body?.prefijo_etiqueta);
  if (!nombre) throw errorHttp(400, 'El nombre de la categoría es obligatorio');
  if (!prefijoValido(prefijo)) throw errorHttp(400, 'El prefijo debe tener 2–6 letras o números (ej. PDA)');
  if (await prefijoCategoriaEnUso(prefijo)) {
    throw errorHttp(409, `Ya existe una categoría con el prefijo ${prefijo}`);
  }
  const formato = texto(body?.formato_etiqueta) || 'completa';
  if (!enLista(FORMATOS_ETIQUETA, formato)) throw errorHttp(400, 'Formato de etiqueta no válido');
  let digitos = Number(body?.digitos_correlativo);
  if (!Number.isInteger(digitos) || digitos < 3 || digitos > 8) digitos = DIGITOS_CORRELATIVO_DEFAULT;

  const categoriaId = nuevoId();
  const item = {
    PK: `CAT#${categoriaId}`,
    SK: SK_META,
    categoria_id: categoriaId,
    nombre,
    prefijo_etiqueta: prefijo,
    digitos_correlativo: digitos,
    formato_etiqueta: formato,
    es_serializable_default: body?.es_serializable_default !== false,
    requiere_firma: body?.requiere_firma === true,
    vida_util_meses: numeroOpcional(body?.vida_util_meses),
    valor_residual_minimo: numeroOpcional(body?.valor_residual_minimo),
    coste_referencia: numeroOpcional(body?.coste_referencia),
    plantilla_documento_id: texto(body?.plantilla_documento_id) || null,
    activo: true,
    gsi_listado: GSI_LISTADO_CAT,
    creado_en: ahora(),
    actualizado_en: ahora(),
    creado_por: actorDe(user).id,
  };
  await putCategoria(item);
  return publicCatalogo(item);
}

export async function editarCategoria(user, categoriaId, body) {
  if (!esUuid(categoriaId)) throw errorHttp(400, 'Categoría no válida');
  const actual = await getCategoria(categoriaId);
  if (!actual) throw errorHttp(404, 'Categoría no encontrada');
  const sets = ['actualizado_en = :now'];
  const values = { ':now': ahora() };
  const names = {};
  if (body?.nombre != null) {
    const nombre = texto(body.nombre);
    if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío');
    sets.push('#n = :n');
    names['#n'] = 'nombre';
    values[':n'] = nombre;
  }
  if (body?.formato_etiqueta != null) {
    if (!enLista(FORMATOS_ETIQUETA, body.formato_etiqueta)) throw errorHttp(400, 'Formato de etiqueta no válido');
    sets.push('formato_etiqueta = :f');
    values[':f'] = body.formato_etiqueta;
  }
  if (body?.es_serializable_default != null) {
    sets.push('es_serializable_default = :s');
    values[':s'] = body.es_serializable_default === true;
  }
  if (body?.requiere_firma != null) {
    sets.push('requiere_firma = :rf');
    values[':rf'] = body.requiere_firma === true;
  }
  if (body?.vida_util_meses !== undefined) {
    sets.push('vida_util_meses = :vu');
    values[':vu'] = numeroOpcional(body.vida_util_meses);
  }
  if (body?.valor_residual_minimo !== undefined) {
    sets.push('valor_residual_minimo = :vr');
    values[':vr'] = numeroOpcional(body.valor_residual_minimo);
  }
  if (body?.coste_referencia !== undefined) {
    sets.push('coste_referencia = :cr');
    values[':cr'] = numeroOpcional(body.coste_referencia);
  }
  if (body?.prefijo_etiqueta != null) {
    const { leerContador } = await import('./store.js');
    const cont = await leerContador(categoriaId);
    if (cont && Number(cont.ultimo_numero) > 0) {
      throw errorHttp(409, 'No se puede cambiar el prefijo: ya hay etiquetas emitidas');
    }
    const prefijo = normalizarPrefijo(body.prefijo_etiqueta);
    if (!prefijoValido(prefijo)) throw errorHttp(400, 'El prefijo no es válido');
    if (await prefijoCategoriaEnUso(prefijo, categoriaId)) {
      throw errorHttp(409, `Ya existe una categoría con el prefijo ${prefijo}`);
    }
    sets.push('prefijo_etiqueta = :pre');
    values[':pre'] = prefijo;
  }
  if (body?.plantilla_documento_id !== undefined) {
    const pid = texto(body.plantilla_documento_id);
    if (pid && !esUuid(pid)) throw errorHttp(400, 'Plantilla no válida');
    sets.push('plantilla_documento_id = :pl');
    values[':pl'] = pid || null;
  }
  await updateCategoria(categoriaId, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
  });
  return publicCatalogo(await getCategoria(categoriaId));
}

export async function bajaCategoria(user, categoriaId) {
  if (!esUuid(categoriaId)) throw errorHttp(400, 'Categoría no válida');
  const actual = await getCategoria(categoriaId);
  if (!actual) throw errorHttp(404, 'Categoría no encontrada');
  const n = await contarModelosActivosDeCategoria(categoriaId);
  if (n > 0) throw errorHttp(409, 'No se puede dar de baja: hay modelos activos en esta categoría');
  await updateCategoria(categoriaId, {
    UpdateExpression: 'SET activo = :no, actualizado_en = :now REMOVE gsi_listado',
    ExpressionAttributeValues: { ':no': false, ':now': ahora() },
  });
  return { ok: true };
}

export async function servicioListarCategorias(query) {
  const r = await listarCategorias({
    cursor: query.cursor,
    limite: query.limite,
    soloActivas: ['1', 'true', 'si'].includes(String(query.soloActivas || '').toLowerCase()),
  });
  return { categorias: r.items.map(publicCatalogo), cursor: r.cursor };
}

async function listarTodasCategorias() {
  const items = [];
  let cursor = null;
  do {
    const r = await listarCategorias({ cursor, limite: 200, soloActivas: true });
    items.push(...r.items);
    cursor = r.cursor;
  } while (cursor);
  return items;
}

function publicPlantilla(item, categorias = []) {
  if (!item) return null;
  const { PK: _pk, SK: _sk, gsi_listado: _g, ...resto } = item;
  const asignadas = categorias.filter((c) => c.plantilla_documento_id === item.plantilla_id && c.activo !== false);
  return {
    ...resto,
    categoria_ids: asignadas.map((c) => c.categoria_id),
    categorias: asignadas.map((c) => ({
      categoria_id: c.categoria_id,
      nombre: c.nombre,
      prefijo_etiqueta: c.prefijo_etiqueta,
    })),
    preview: renderCuerpoPlantilla(item.cuerpo, DATOS_PREVIEW_PLANTILLA),
  };
}

async function asignarPlantillaACategorias(plantillaId, categoriaIds) {
  const ids = new Set((Array.isArray(categoriaIds) ? categoriaIds : []).map((id) => texto(id)).filter(esUuid));
  const cats = await listarTodasCategorias();
  for (const c of cats) {
    const era = c.plantilla_documento_id === plantillaId;
    const debe = ids.has(c.categoria_id);
    if (era === debe) continue;
    await updateCategoria(c.categoria_id, {
      UpdateExpression: 'SET plantilla_documento_id = :pl, actualizado_en = :now',
      ExpressionAttributeValues: { ':pl': debe ? plantillaId : null, ':now': ahora() },
    });
  }
}

export async function servicioListarPlantillas(query) {
  const r = await listarPlantillas({
    cursor: query.cursor,
    limite: query.limite,
    soloActivas: ['1', 'true', 'si'].includes(String(query.soloActivas || '').toLowerCase()),
  });
  const cats = await listarTodasCategorias();
  return { plantillas: r.items.map((it) => publicPlantilla(it, cats)), cursor: r.cursor };
}

export async function servicioGetPlantilla(plantillaId) {
  if (!esUuid(plantillaId)) throw errorHttp(400, 'Plantilla no válida');
  const item = await getPlantilla(plantillaId);
  if (!item || item.activo === false) throw errorHttp(404, 'Plantilla no encontrada');
  const cats = await listarTodasCategorias();
  return publicPlantilla(item, cats);
}

export async function crearPlantilla(user, body) {
  const nombre = texto(body?.nombre);
  if (!nombre) throw errorHttp(400, 'El nombre de la plantilla es obligatorio');
  const cuerpo = sanitizarHtmlPlantilla(texto(body?.cuerpo) || CUERPO_PLANTILLA_DEFAULT);
  const plantillaId = nuevoId();
  const item = {
    PK: `${PREFIJO_PLANT}${plantillaId}`,
    SK: SK_META,
    plantilla_id: plantillaId,
    nombre,
    cuerpo,
    activo: true,
    gsi_listado: GSI_LISTADO_PLANT,
    creado_en: ahora(),
    actualizado_en: ahora(),
    creado_por: actorDe(user).id,
  };
  await putPlantilla(item);
  if (body?.categoria_ids) await asignarPlantillaACategorias(plantillaId, body.categoria_ids);
  const cats = await listarTodasCategorias();
  return publicPlantilla(await getPlantilla(plantillaId), cats);
}

export async function editarPlantilla(user, plantillaId, body) {
  if (!esUuid(plantillaId)) throw errorHttp(400, 'Plantilla no válida');
  const actual = await getPlantilla(plantillaId);
  if (!actual || actual.activo === false) throw errorHttp(404, 'Plantilla no encontrada');
  const sets = ['actualizado_en = :now'];
  const values = { ':now': ahora() };
  const names = {};
  if (body?.nombre != null) {
    const nombre = texto(body.nombre);
    if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío');
    sets.push('#n = :n');
    names['#n'] = 'nombre';
    values[':n'] = nombre;
  }
  if (body?.cuerpo != null) {
    const cuerpo = sanitizarHtmlPlantilla(texto(body.cuerpo));
    if (!cuerpo) throw errorHttp(400, 'El texto de la plantilla no puede quedar vacío');
    sets.push('cuerpo = :c');
    values[':c'] = cuerpo;
  }
  await updatePlantilla(plantillaId, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
  });
  if (body?.categoria_ids !== undefined) {
    await asignarPlantillaACategorias(plantillaId, body.categoria_ids);
  }
  const cats = await listarTodasCategorias();
  return publicPlantilla(await getPlantilla(plantillaId), cats);
}

export async function bajaPlantilla(user, plantillaId) {
  if (!esUuid(plantillaId)) throw errorHttp(400, 'Plantilla no válida');
  const actual = await getPlantilla(plantillaId);
  if (!actual) throw errorHttp(404, 'Plantilla no encontrada');
  await asignarPlantillaACategorias(plantillaId, []);
  await updatePlantilla(plantillaId, {
    UpdateExpression: 'SET activo = :no, actualizado_en = :now REMOVE gsi_listado',
    ExpressionAttributeValues: { ':no': false, ':now': ahora() },
  });
  return { ok: true };
}

export function previewPlantillaCuerpo(body) {
  const cuerpo = texto(body?.cuerpo) || CUERPO_PLANTILLA_DEFAULT;
  return { preview: renderCuerpoPlantilla(cuerpo, DATOS_PREVIEW_PLANTILLA) };
}

export async function crearModelo(user, body) {
  const categoriaId = texto(body?.categoria_id);
  if (!esUuid(categoriaId)) throw errorHttp(400, 'Indica una categoría válida');
  const cat = await getCategoria(categoriaId);
  if (!cat || cat.activo === false) throw errorHttp(400, 'La categoría no existe o está dada de baja');
  const nombre = texto(body?.nombre);
  const marca = texto(body?.marca);
  if (!nombre) throw errorHttp(400, 'El nombre del modelo es obligatorio');
  if (!marca) throw errorHttp(400, 'La marca es obligatoria');
  const modeloId = nuevoId();
  const item = {
    PK: `MOD#${modeloId}`,
    SK: SK_META,
    modelo_id: modeloId,
    categoria_id: categoriaId,
    marca,
    marca_norm: marca.toLowerCase(),
    nombre,
    es_serializable: body?.es_serializable == null ? cat.es_serializable_default !== false : body.es_serializable === true,
    requiere_firma: body?.requiere_firma == null ? cat.requiere_firma === true : body.requiere_firma === true,
    atributos_schema: Array.isArray(body?.atributos_schema) ? body.atributos_schema : [],
    activo: true,
    gsi_listado: GSI_LISTADO_MOD,
    creado_en: ahora(),
    actualizado_en: ahora(),
    creado_por: actorDe(user).id,
  };
  await putModelo(item);
  return publicCatalogoConFoto(item);
}

export async function editarModelo(user, modeloId, body) {
  if (!esUuid(modeloId)) throw errorHttp(400, 'Modelo no válido');
  const actual = await getModelo(modeloId);
  if (!actual) throw errorHttp(404, 'Modelo no encontrado');
  const sets = ['actualizado_en = :now'];
  const values = { ':now': ahora() };
  const names = {};
  if (body?.nombre != null) {
    const nombre = texto(body.nombre);
    if (!nombre) throw errorHttp(400, 'El nombre no puede quedar vacío');
    sets.push('#n = :n');
    names['#n'] = 'nombre';
    values[':n'] = nombre;
  }
  if (body?.marca != null) {
    const marca = texto(body.marca);
    if (!marca) throw errorHttp(400, 'La marca no puede quedar vacía');
    sets.push('marca = :m, marca_norm = :mn');
    values[':m'] = marca;
    values[':mn'] = marca.toLowerCase();
  }
  if (body?.es_serializable != null) {
    sets.push('es_serializable = :s');
    values[':s'] = body.es_serializable === true;
  }
  if (body?.requiere_firma != null) {
    sets.push('requiere_firma = :rf');
    values[':rf'] = body.requiere_firma === true;
  }
  if (body?.atributos_schema != null) {
    sets.push('atributos_schema = :as');
    values[':as'] = Array.isArray(body.atributos_schema) ? body.atributos_schema : [];
  }
  await updateModelo(modeloId, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
  });
  return publicCatalogoConFoto(await getModelo(modeloId));
}

export async function bajaModelo(user, modeloId) {
  if (!esUuid(modeloId)) throw errorHttp(400, 'Modelo no válido');
  const actual = await getModelo(modeloId);
  if (!actual) throw errorHttp(404, 'Modelo no encontrado');
  if (await hayActivosDeModelo(modeloId)) {
    throw errorHttp(409, 'No se puede dar de baja: hay activos de este modelo');
  }
  await updateModelo(modeloId, {
    UpdateExpression: 'SET activo = :no, actualizado_en = :now REMOVE gsi_listado',
    ExpressionAttributeValues: { ':no': false, ':now': ahora() },
  });
  return { ok: true };
}

export async function servicioListarModelos(query) {
  const r = await listarModelos({
    categoriaId: texto(query.categoria_id) || undefined,
    marcaNorm: texto(query.marca).toLowerCase() || undefined,
    cursor: query.cursor,
    limite: query.limite,
    soloActivos: ['1', 'true', 'si'].includes(String(query.soloActivos || '').toLowerCase()),
  });
  const modelos = await Promise.all(r.items.map((it) => publicCatalogoConFoto(it)));
  const conStock = ['1', 'true', 'si'].includes(String(query.conStock || '').toLowerCase());
  if (!conStock) return { modelos, cursor: r.cursor };
  try {
    const { totales, porTalla } = await sumarDisponiblePorModelo();
    return {
      modelos: modelos.map((m) => {
        if (!m) return m;
        return {
          ...m,
          disponible: totales.get(m.modelo_id) || 0,
          tallas: tallasDesdeMapa(porTalla.get(m.modelo_id)),
        };
      }),
      cursor: r.cursor,
    };
  } catch {
    return { modelos, cursor: r.cursor };
  }
}

export async function servicioGetModelo(modeloId) {
  if (!esUuid(modeloId)) throw errorHttp(400, 'Modelo no válido');
  const item = await getModelo(modeloId);
  if (!item) throw errorHttp(404, 'Modelo no encontrado');
  return publicCatalogoConFoto(item);
}

async function exigirModelo(modeloId) {
  if (!esUuid(modeloId)) throw errorHttp(400, 'Modelo no válido');
  const item = await getModelo(modeloId);
  if (!item || item.activo === false) throw errorHttp(404, 'Modelo no encontrado');
  return item;
}

/** Detalle del stock libre de un modelo, línea a línea, ya filtrado por local. */
export async function servicioStockModelo(user, modeloId) {
  await exigirModelo(modeloId);
  const permitidos = await idsLocalesPermitidos(user);
  const items = [];
  let cursor = null;
  do {
    const r = await listarActivosDeModelo(modeloId, { cursor, limite: 100 });
    items.push(...(r.items || []));
    cursor = r.cursor || null;
  } while (cursor);
  const lineas = lineasDisponibles(filtrarPorAlcance(items, permitidos));
  return {
    modelo_id: modeloId,
    total: lineas.reduce((n, l) => n + l.disponibles, 0),
    lineas,
  };
}

export async function presignFotoModelo(user, modeloId, body) {
  await exigirModelo(modeloId);
  const fotoId = nuevoId();
  return presignarSubidaModelo({
    modeloId,
    fotoId,
    contentType: body?.content_type,
  });
}

export async function confirmarFotoModelo(user, modeloId, body) {
  const actual = await exigirModelo(modeloId);
  const s3Key = texto(body?.s3_key);
  const fotoId = texto(body?.foto_id);
  if (!s3Key || !fotoId) throw errorHttp(400, 'Faltan s3_key o foto_id');
  if (!clavePerteneceAlModelo(s3Key, modeloId)) throw errorHttp(400, 'La clave de fichero no pertenece a este modelo');
  if (actual.foto_s3_key && actual.foto_s3_key !== s3Key) await borrarObjeto(actual.foto_s3_key);
  await updateModelo(modeloId, {
    UpdateExpression: 'SET foto_s3_key = :k, actualizado_en = :now',
    ExpressionAttributeValues: { ':k': s3Key, ':now': ahora() },
  });
  return publicCatalogoConFoto(await getModelo(modeloId));
}

export async function borrarFotoModelo(user, modeloId) {
  const actual = await exigirModelo(modeloId);
  if (actual.foto_s3_key) await borrarObjeto(actual.foto_s3_key);
  await updateModelo(modeloId, {
    UpdateExpression: 'SET actualizado_en = :now REMOVE foto_s3_key',
    ExpressionAttributeValues: { ':now': ahora() },
  });
  return publicCatalogoConFoto(await getModelo(modeloId));
}

// ─── Activos ───

async function cargarModeloYCategoria(modeloId) {
  if (!esUuid(modeloId)) throw errorHttp(400, 'Indica un modelo válido');
  const modelo = await getModelo(modeloId);
  if (!modelo || modelo.activo === false) throw errorHttp(400, 'El modelo no existe o está dado de baja');
  const categoria = await getCategoria(modelo.categoria_id);
  if (!categoria || categoria.activo === false) throw errorHttp(400, 'La categoría del modelo no está activa');
  return { modelo, categoria };
}

async function altaUnaUnidad({ modelo, categoria, local, actor, serializable, cantidad, atributos, numeroSerie, coste, fechaCompra, notas }) {
  const granularidad = serializable ? GRANULARIDAD.unidad : GRANULARIDAD.lote;
  if (!serializable) {
    const existente = await buscarLoteEnLocal(modelo.modelo_id, local.id_local, atributosNorm(atributos));
    if (existente) {
      const updated = await updateActivo(existente.asset_id, {
        UpdateExpression: 'SET cantidad = cantidad + :c, actualizado_en = :now',
        ExpressionAttributeValues: { ':c': cantidad, ':now': ahora() },
      });
      await putEvento(itemEvento({
        assetId: existente.asset_id,
        eventoId: nuevoId(),
        tipo: EVENTO.alta,
        usuario: actor,
        antes: { cantidad: existente.cantidad },
        despues: { cantidad: existente.cantidad + cantidad, id_local: local.id_local },
      }));
      return publicActivo(updated);
    }
  }
  const correlativo = await reservarCorrelativo(categoria.categoria_id);
  const etiqueta = formatearEtiqueta(
    categoria.prefijo_etiqueta,
    correlativo,
    categoria.digitos_correlativo || DIGITOS_CORRELATIVO_DEFAULT,
  );
  const activo = construirActivo({
    assetId: nuevoId(),
    etiqueta,
    categoria,
    modelo,
    local,
    granularidad,
    cantidad,
    numeroSerie,
    atributos,
    estado: ESTADO.en_almacen,
    coste,
    fechaCompra,
    notas,
    actor,
  });
  const evento = itemEvento({
    assetId: activo.asset_id,
    eventoId: nuevoId(),
    tipo: EVENTO.alta,
    usuario: actor,
    despues: { etiqueta_legible: etiqueta, id_local: local.id_local, cantidad },
  });
  await persistirAlta(activo, evento);
  return publicActivo(activo);
}

export async function crearActivo(user, body) {
  const { modelo, categoria } = await cargarModeloYCategoria(body?.modelo_id);
  const local = await asegurarLocalAccesible(user, body?.id_local);
  const actor = actorDe(user);
  const serializable = modelo.es_serializable === true;
  const comunes = {
    coste: numeroOpcional(body?.coste_adquisicion),
    fechaCompra: texto(body?.fecha_compra) || null,
    notas: body?.notas,
  };

  const lineas = Array.isArray(body?.lineas) ? body.lineas : [];
  if (!serializable && lineas.length > 0) {
    const vistos = new Set();
    const preparadas = [];
    for (const linea of lineas) {
      const talla = texto(linea?.talla);
      const c = Number(linea?.cantidad);
      if (!talla) throw errorHttp(400, 'Indica la talla en cada línea');
      if (!Number.isInteger(c) || c < 1) throw errorHttp(400, 'La cantidad de cada talla debe ser al menos 1');
      if (vistos.has(talla)) throw errorHttp(400, `La talla ${talla} está repetida`);
      vistos.add(talla);
      preparadas.push({
        cantidad: c,
        atributos: atributosSegunSchema(modelo, { ...(linea?.atributos || {}), talla }),
      });
    }
    const creados = [];
    for (const linea of preparadas) {
      creados.push(await altaUnaUnidad({
        modelo,
        categoria,
        local,
        actor,
        serializable: false,
        cantidad: linea.cantidad,
        atributos: linea.atributos,
        numeroSerie: null,
        ...comunes,
      }));
    }
    return { activos: creados };
  }

  let cantidad = 1;
  if (!serializable) {
    const c = Number(body?.cantidad);
    cantidad = Number.isInteger(c) && c >= 1 ? c : 1;
  }
  const atributos = atributosSegunSchema(modelo, body?.atributos);
  return altaUnaUnidad({
    modelo,
    categoria,
    local,
    actor,
    serializable,
    cantidad,
    atributos,
    numeroSerie: body?.numero_serie,
    ...comunes,
  });
}

export async function crearActivosLote(user, body) {
  const { modelo, categoria } = await cargarModeloYCategoria(body?.modelo_id);
  const local = await asegurarLocalAccesible(user, body?.id_local);
  const actor = actorDe(user);
  const loteAltaId = nuevoId();
  const comunes = body?.comunes && typeof body.comunes === 'object' ? body.comunes : {};
  const unidades = Array.isArray(body?.unidades) ? body.unidades : [];
  const cantidad = Number(body?.cantidad);
  const n = unidades.length > 0
    ? unidades.length
    : (Number.isInteger(cantidad) && cantidad >= 1 ? cantidad : 0);
  if (n < 1) throw errorHttp(400, 'Indica la cantidad o la lista de unidades');
  if (n > LOTE_MAX_UNIDADES) throw errorHttp(400, `El alta por lote admite como máximo ${LOTE_MAX_UNIDADES} unidades`);

  const creados = [];
  for (let i = 0; i < n; i += 1) {
    const extra = unidades[i] && typeof unidades[i] === 'object' ? unidades[i] : {};
    const correlativo = await reservarCorrelativo(categoria.categoria_id);
    const etiqueta = formatearEtiqueta(
      categoria.prefijo_etiqueta,
      correlativo,
      categoria.digitos_correlativo || DIGITOS_CORRELATIVO_DEFAULT,
    );
    const serializable = modelo.es_serializable === true;
    const activo = construirActivo({
      assetId: nuevoId(),
      etiqueta,
      categoria,
      modelo,
      local,
      granularidad: serializable ? GRANULARIDAD.unidad : GRANULARIDAD.lote,
      cantidad: serializable ? 1 : Number(extra.cantidad || comunes.cantidad || 1) || 1,
      numeroSerie: extra.numero_serie,
      atributos: extra.atributos || comunes.atributos,
      estado: ESTADO.en_almacen,
      coste: numeroOpcional(extra.coste_adquisicion ?? comunes.coste_adquisicion),
      fechaCompra: texto(extra.fecha_compra ?? comunes.fecha_compra) || null,
      notas: extra.notas ?? comunes.notas,
      actor,
    });
    const evento = itemEvento({
      assetId: activo.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.alta,
      usuario: actor,
      despues: { etiqueta_legible: etiqueta, id_local: local.id_local, cantidad: activo.cantidad },
      loteAltaId,
    });
    await persistirAlta(activo, evento);
    creados.push(publicActivo(activo));
  }
  return { lote_alta_id: loteAltaId, activos: creados };
}

export async function getFicha(user, assetId, { conFotos = true } = {}) {
  const item = await exigirActivoVisible(user, assetId);
  const urls = conFotos ? await urlsFirmadasDeFotos(item.fotos) : null;
  const pub = publicActivo(item, urls);
  if (!conFotos || fotoGeneralDe(item)) return pub;
  const modelo = item.modelo_id ? await getModelo(item.modelo_id) : null;
  if (!modelo?.foto_s3_key) return pub;
  const url = await urlFirmadaLectura(modelo.foto_s3_key);
  return {
    ...pub,
    foto_url: url,
    fotos: [{ foto_id: 'modelo', tipo: 'general', creado_en: modelo.actualizado_en, url }, ...(pub.fotos || [])],
  };
}

export async function resolverActivo(user, assetId) {
  return getFicha(user, assetId, { conFotos: true });
}

function filtrarPorAlcance(items, permitidos) {
  if (permitidos == null) return items;
  return items.filter((it) => permitidos.has(idLocalNorm(it.id_local)));
}

export async function servicioListarActivos(user, query) {
  const idLocal = idLocalNorm(query.id_local);
  const estado = texto(query.estado) || '';
  const categoriaId = texto(query.categoria_id) || '';
  const q = texto(query.q);
  const permitidos = await idsLocalesPermitidos(user);

  if (q) {
    let hallados = [];
    if (esUuid(q)) {
      const uno = await getActivo(q);
      if (uno) hallados = [uno];
    } else {
      const et = parsearEtiqueta(q);
      if (et) {
        hallados = await buscarPorEtiqueta(et.prefijo, et.etiqueta, { exacta: et.cuerpoConCheck.length >= 5 });
        if (!hallados.length) {
          hallados = await buscarPorEtiqueta(et.prefijo, `${et.prefijo}-`, { exacta: false });
          hallados = hallados.filter((it) => it.etiqueta_legible.startsWith(et.etiqueta));
        }
      } else {
        const serie = normalizarSerie(q);
        if (serie) hallados = await buscarPorSerie(serie);
      }
    }
    let items = filtrarPorAlcance(hallados, permitidos);
    if (idLocal) items = items.filter((it) => it.id_local === idLocal);
    if (estado) items = items.filter((it) => it.estado === estado);
    if (categoriaId) items = items.filter((it) => it.categoria_id === categoriaId);
    return { activos: await publicActivosListado(items), cursor: null };
  }

  if (idLocal) {
    await asegurarLocalAccesible(user, idLocal);
    const r = await listarActivosPorLocal({
      idLocal,
      estado: estado || undefined,
      categoriaId: categoriaId || undefined,
      cursor: query.cursor,
      limite: query.limite,
    });
    return { activos: await publicActivosListado(r.items), cursor: r.cursor };
  }

  if (permitidos !== null) {
    throw errorHttp(400, 'Indica un local para listar los activos');
  }
  const r = await listarActivosGlobal({
    cursor: query.cursor,
    limite: query.limite,
    estado: estado || undefined,
    categoriaId: categoriaId || undefined,
  });
  return { activos: await publicActivosListado(r.items), cursor: r.cursor };
}

export async function servicioPendientes(user, query) {
  const idLocal = idLocalNorm(query.id_local);
  if (!idLocal) throw errorHttp(400, 'Indica un local para ver los pendientes de verificar');
  await asegurarLocalAccesible(user, idLocal);
  const r = await listarPendientesVerificacion({
    idLocal,
    cursor: query.cursor,
    limite: query.limite,
  });
  return { activos: await publicActivosListado(r.items), cursor: r.cursor };
}

export async function servicioEventos(user, assetId, query) {
  await exigirActivoVisible(user, assetId);
  const r = await listarEventos(assetId, { cursor: query.cursor, limite: query.limite });
  return { eventos: r.items.map(publicEvento), cursor: r.cursor };
}

export async function editarActivo(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  if (actual.estado === ESTADO.baja) throw errorHttp(409, 'Un activo dado de baja no se puede editar');
  const actor = actorDe(user);
  const antes = {};
  const despues = {};
  const sets = ['actualizado_en = :now'];
  const removes = [];
  const values = { ':now': ahora() };

  if (body?.notas !== undefined) {
    antes.notas = actual.notas ?? null;
    despues.notas = texto(body.notas) || null;
    sets.push('notas = :notas');
    values[':notas'] = despues.notas;
  }
  if (body?.coste_adquisicion !== undefined) {
    antes.coste_adquisicion = actual.coste_adquisicion ?? null;
    despues.coste_adquisicion = numeroOpcional(body.coste_adquisicion);
    sets.push('coste_adquisicion = :coste');
    values[':coste'] = despues.coste_adquisicion;
  }
  if (body?.fecha_compra !== undefined) {
    antes.fecha_compra = actual.fecha_compra ?? null;
    despues.fecha_compra = texto(body.fecha_compra) || null;
    sets.push('fecha_compra = :fc');
    values[':fc'] = despues.fecha_compra;
  }
  if (body?.atributos !== undefined) {
    const attrs = parseAtributos(body.atributos);
    antes.atributos = actual.atributos ?? {};
    despues.atributos = attrs;
    sets.push('atributos = :at, atributos_norm = :an');
    values[':at'] = attrs;
    values[':an'] = atributosNorm(attrs);
  }
  if (body?.numero_serie !== undefined) {
    const serie = normalizarSerie(body.numero_serie);
    antes.numero_serie = actual.numero_serie ?? null;
    despues.numero_serie = serie || null;
    sets.push('numero_serie = :ns');
    values[':ns'] = despues.numero_serie;
    if (serie) {
      sets.push('numero_serie_norm = :nsn');
      values[':nsn'] = serie;
    } else {
      removes.push('numero_serie_norm');
    }
  }
  if (Object.keys(despues).length === 0) throw errorHttp(400, 'No hay cambios que guardar');

  const expr = `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`;
  const updated = await updateActivo(assetId, {
    UpdateExpression: expr,
    ExpressionAttributeValues: values,
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.edicion,
    usuario: actor,
    antes,
    despues,
  }));
  return publicActivo(updated);
}

export async function trasladarActivo(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  if (actual.estado === ESTADO.baja) throw errorHttp(409, 'Un activo dado de baja no se puede trasladar');
  if (actual.custodio_id) throw errorHttp(409, 'Primero hay que devolverlo: un activo entregado no se traslada');
  const destino = await asegurarLocalAccesible(user, body?.id_local);
  if (destino.id_local === actual.id_local) throw errorHttp(400, 'El activo ya está en ese local');
  const actor = actorDe(user);

  if (actual.granularidad === GRANULARIDAD.lote && body?.cantidad != null) {
    const mover = Number(body.cantidad);
    if (!Number.isInteger(mover) || mover < 1) throw errorHttp(400, 'La cantidad a trasladar no es válida');
    if (mover > actual.cantidad) throw errorHttp(400, 'No hay tantas unidades en este lote');
    if (mover < actual.cantidad) {
      return trasladoParcialLote(user, actual, destino, mover, actor, body?.notas);
    }
  }

  const updated = await updateActivo(assetId, {
    UpdateExpression:
      'SET id_local = :loc, local_nombre = :nom, empresa_id = :emp, actualizado_en = :now, gsi_estado_cat_etiqueta = :gse',
    ExpressionAttributeValues: {
      ':loc': destino.id_local,
      ':nom': destino.local_nombre,
      ':emp': destino.empresa_id,
      ':now': ahora(),
      ':gse': claveEstadoCatEtiqueta(actual.estado, actual.categoria_id, actual.etiqueta_legible),
    },
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.traslado,
    usuario: actor,
    antes: { id_local: actual.id_local, local_nombre: actual.local_nombre },
    despues: { id_local: destino.id_local, local_nombre: destino.local_nombre },
    notas: texto(body?.notas) || null,
  }));
  return publicActivo(updated);
}

async function trasladoParcialLote(user, origen, destino, cantidad, actor, notas) {
  const resto = origen.cantidad - cantidad;
  const existente = await buscarLoteEnLocal(origen.modelo_id, destino.id_local, origen.atributos_norm);
  let destinoItem;
  if (existente) {
    destinoItem = await updateActivo(existente.asset_id, {
      UpdateExpression: 'SET cantidad = cantidad + :c, actualizado_en = :now',
      ExpressionAttributeValues: { ':c': cantidad, ':now': ahora() },
    });
    await putEvento(itemEvento({
      assetId: existente.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.traslado,
      usuario: actor,
      antes: { cantidad: existente.cantidad },
      despues: { cantidad: existente.cantidad + cantidad, desde: origen.asset_id },
      notas: texto(notas) || null,
    }));
  } else {
    const { modelo, categoria } = await cargarModeloYCategoria(origen.modelo_id);
    const correlativo = await reservarCorrelativo(categoria.categoria_id);
    const etiqueta = formatearEtiqueta(
      categoria.prefijo_etiqueta,
      correlativo,
      categoria.digitos_correlativo || DIGITOS_CORRELATIVO_DEFAULT,
    );
    const nuevo = construirActivo({
      assetId: nuevoId(),
      etiqueta,
      categoria,
      modelo,
      local: destino,
      granularidad: GRANULARIDAD.lote,
      cantidad,
      numeroSerie: null,
      atributos: origen.atributos,
      estado: origen.estado,
      coste: origen.coste_adquisicion,
      fechaCompra: origen.fecha_compra,
      notas: origen.notas,
      actor,
    });
    const evento = itemEvento({
      assetId: nuevo.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.traslado,
      usuario: actor,
      despues: { cantidad, desde: origen.asset_id, id_local: destino.id_local },
      notas: texto(notas) || null,
    });
    await persistirAlta(nuevo, evento);
    destinoItem = nuevo;
  }

  const origenUpd = resto === 0
    ? await aplicarBaja(origen, actor, 'Traslado total del lote')
    : await updateActivo(origen.asset_id, {
      UpdateExpression: 'SET cantidad = :c, actualizado_en = :now',
      ExpressionAttributeValues: { ':c': resto, ':now': ahora() },
    });
  if (resto > 0) {
    await putEvento(itemEvento({
      assetId: origen.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.traslado,
      usuario: actor,
      antes: { cantidad: origen.cantidad, id_local: origen.id_local },
      despues: { cantidad: resto, hacia: destino.id_local },
      notas: texto(notas) || null,
    }));
  }
  return { origen: publicActivo(origenUpd), destino: publicActivo(destinoItem) };
}

async function cargarEmpleado(employeeId, { exigirActivo = false } = {}) {
  const id = texto(employeeId);
  if (!id) throw errorHttp(400, 'Indica el trabajador');
  const emp = await getEmployeeById(docClient, tables.empleados, id);
  if (!emp) throw errorHttp(404, 'Empleado no encontrado');
  if (exigirActivo && emp.active === false) throw errorHttp(400, 'El empleado no está activo');
  const nombre = texto(emp.full_name)
    || [emp.first_name, emp.last_name].filter(Boolean).join(' ').trim()
    || id;
  return { id: String(emp.employee_id ?? id), nombre };
}

async function listarTodosAsignados() {
  const items = [];
  let cursor = null;
  do {
    const r = await listarAsignados({ cursor, limite: 100 });
    items.push(...(r.items || []).filter((it) => it.custodio_id));
    cursor = r.cursor || null;
  } while (cursor);
  return items;
}

async function marcarAsignado(actual, empleado, actor, notas, imputado) {
  const gse = claveEstadoCatEtiqueta(ESTADO.asignado, actual.categoria_id, actual.etiqueta_legible);
  const updated = await updateActivo(actual.asset_id, {
    UpdateExpression:
      'SET estado = :est, custodio_id = :cid, custodio_tipo = :ct, custodio_nombre = :cn, asignado_en = :now, actualizado_en = :now, gsi_estado_cat_etiqueta = :gse, local_imputado_id = :lii, local_imputado_nombre = :lin',
    ExpressionAttributeValues: {
      ':est': ESTADO.asignado,
      ':cid': empleado.id,
      ':ct': 'personal',
      ':cn': empleado.nombre,
      ':now': ahora(),
      ':gse': gse,
      ':lii': imputado.id_local,
      ':lin': imputado.local_nombre,
    },
  });
  await putEvento(itemEvento({
    assetId: actual.asset_id,
    eventoId: nuevoId(),
    tipo: EVENTO.entrega,
    usuario: actor,
    antes: { estado: actual.estado, custodio_id: actual.custodio_id || null, cantidad: actual.cantidad },
    despues: {
      estado: ESTADO.asignado,
      custodio_id: empleado.id,
      custodio_nombre: empleado.nombre,
      cantidad: actual.cantidad,
      local_imputado_id: imputado.id_local,
      local_imputado_nombre: imputado.local_nombre,
    },
    notas: texto(notas) || null,
  }));
  return updated;
}

async function marcarEnAlmacen(actual, actor, notas) {
  const gse = claveEstadoCatEtiqueta(ESTADO.en_almacen, actual.categoria_id, actual.etiqueta_legible);
  const updated = await updateActivo(actual.asset_id, {
    UpdateExpression:
      'SET estado = :est, actualizado_en = :now, gsi_estado_cat_etiqueta = :gse REMOVE custodio_id, custodio_tipo, custodio_nombre, asignado_en, local_imputado_id, local_imputado_nombre',
    ExpressionAttributeValues: {
      ':est': ESTADO.en_almacen,
      ':now': ahora(),
      ':gse': gse,
    },
  });
  await putEvento(itemEvento({
    assetId: actual.asset_id,
    eventoId: nuevoId(),
    tipo: EVENTO.devolucion,
    usuario: actor,
    antes: {
      estado: actual.estado,
      custodio_id: actual.custodio_id || null,
      cantidad: actual.cantidad,
      local_imputado_id: actual.local_imputado_id || null,
    },
    despues: { estado: ESTADO.en_almacen, custodio_id: null, cantidad: actual.cantidad, local_imputado_id: null },
    notas: texto(notas) || null,
  }));
  return updated;
}

async function crearLoteDerivado(origen, { cantidad, estado, local, custodio, imputado, actor, tipoEvento, despues, notas }) {
  const { modelo, categoria } = await cargarModeloYCategoria(origen.modelo_id);
  const correlativo = await reservarCorrelativo(categoria.categoria_id);
  const etiqueta = formatearEtiqueta(
    categoria.prefijo_etiqueta,
    correlativo,
    categoria.digitos_correlativo || DIGITOS_CORRELATIVO_DEFAULT,
  );
  const nuevo = construirActivo({
    assetId: nuevoId(),
    etiqueta,
    categoria,
    modelo,
    local: local || {
      id_local: origen.id_local,
      local_nombre: origen.local_nombre,
      empresa_id: origen.empresa_id,
    },
    granularidad: GRANULARIDAD.lote,
    cantidad,
    numeroSerie: null,
    atributos: origen.atributos,
    estado,
    coste: origen.coste_adquisicion,
    fechaCompra: origen.fecha_compra,
    notas: origen.notas,
    actor,
    custodio,
    imputado: imputado || null,
  });
  const evento = itemEvento({
    assetId: nuevo.asset_id,
    eventoId: nuevoId(),
    tipo: tipoEvento,
    usuario: actor,
    despues,
    notas: texto(notas) || null,
  });
  await persistirAlta(nuevo, evento);
  return nuevo;
}

async function restarCantidadLote(origen, qty, actor, tipoEvento, notas, extraDespues = {}) {
  const resto = origen.cantidad - qty;
  if (resto <= 0) {
    return aplicarBaja(origen, actor, notas || 'Sin unidades restantes');
  }
  const updated = await updateActivo(origen.asset_id, {
    UpdateExpression: 'SET cantidad = :c, actualizado_en = :now',
    ExpressionAttributeValues: { ':c': resto, ':now': ahora() },
  });
  await putEvento(itemEvento({
    assetId: origen.asset_id,
    eventoId: nuevoId(),
    tipo: tipoEvento,
    usuario: actor,
    antes: { cantidad: origen.cantidad },
    despues: { cantidad: resto, ...extraDespues },
    notas: texto(notas) || null,
  }));
  return updated;
}

async function entregarUnaLinea(user, origen, empleado, qty, actor, notas, imputado) {
  if (origen.estado === ESTADO.baja) throw errorHttp(409, `${origen.etiqueta_legible}: está dado de baja`);
  if (origen.custodio_id || origen.estado === ESTADO.asignado) {
    throw errorHttp(409, `${origen.etiqueta_legible}: ya está entregado`);
  }
  if (origen.estado !== ESTADO.en_almacen) {
    throw errorHttp(409, `${origen.etiqueta_legible}: solo se puede entregar desde almacén`);
  }
  await asegurarLocalAccesible(user, origen.id_local);

  if (origen.granularidad !== GRANULARIDAD.lote) {
    return publicActivo(await marcarAsignado(origen, empleado, actor, notas, imputado));
  }

  const disponible = unidadesDe(origen);
  if (!Number.isInteger(qty) || qty < 1) throw errorHttp(400, `${origen.etiqueta_legible}: indica cuántas unidades`);
  if (qty > disponible) throw errorHttp(400, `${origen.etiqueta_legible}: no hay tantas unidades`);

  // Solo se fusiona con lo ya entregado si se imputa al mismo local: si no,
  // luego no se podría separar la factura.
  const existente = await buscarLoteAsignado(
    origen.modelo_id,
    origen.id_local,
    origen.atributos_norm,
    empleado.id,
    imputado.id_local,
  );
  if (qty === disponible && !existente) {
    return publicActivo(await marcarAsignado(origen, empleado, actor, notas, imputado));
  }

  let destino;
  if (existente) {
    destino = await updateActivo(existente.asset_id, {
      UpdateExpression: 'SET cantidad = cantidad + :c, actualizado_en = :now, local_imputado_id = :lii, local_imputado_nombre = :lin',
      ExpressionAttributeValues: {
        ':c': qty,
        ':now': ahora(),
        ':lii': imputado.id_local,
        ':lin': imputado.local_nombre,
      },
    });
    await putEvento(itemEvento({
      assetId: existente.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.entrega,
      usuario: actor,
      antes: { cantidad: existente.cantidad },
      despues: {
        cantidad: existente.cantidad + qty,
        custodio_id: empleado.id,
        desde: origen.asset_id,
        local_imputado_id: imputado.id_local,
        local_imputado_nombre: imputado.local_nombre,
      },
      notas: texto(notas) || null,
    }));
  } else {
    destino = await crearLoteDerivado(origen, {
      cantidad: qty,
      estado: ESTADO.asignado,
      custodio: empleado,
      imputado,
      actor,
      tipoEvento: EVENTO.entrega,
      despues: {
        cantidad: qty,
        custodio_id: empleado.id,
        custodio_nombre: empleado.nombre,
        desde: origen.asset_id,
        local_imputado_id: imputado.id_local,
        local_imputado_nombre: imputado.local_nombre,
      },
      notas,
    });
  }
  await restarCantidadLote(origen, qty, actor, EVENTO.entrega, notas, { hacia: empleado.id });
  return publicActivo(destino);
}

async function devolverUnaLinea(user, origen, empleado, qty, actor, notas) {
  if (String(origen.custodio_id || '') !== empleado.id) {
    throw errorHttp(409, `${origen.etiqueta_legible}: no está entregado a ese trabajador`);
  }
  if (origen.estado !== ESTADO.asignado) {
    throw errorHttp(409, `${origen.etiqueta_legible}: no está asignado`);
  }
  await asegurarLocalAccesible(user, origen.id_local);

  if (origen.granularidad !== GRANULARIDAD.lote) {
    return publicActivo(await marcarEnAlmacen(origen, actor, notas));
  }

  const disponible = unidadesDe(origen);
  if (!Number.isInteger(qty) || qty < 1) throw errorHttp(400, `${origen.etiqueta_legible}: indica cuántas unidades`);
  if (qty > disponible) throw errorHttp(400, `${origen.etiqueta_legible}: no hay tantas unidades asignadas`);

  const almacen = await buscarLoteEnLocal(origen.modelo_id, origen.id_local, origen.atributos_norm);
  if (qty === disponible && !almacen) {
    return publicActivo(await marcarEnAlmacen(origen, actor, notas));
  }

  let destino;
  if (almacen) {
    destino = await updateActivo(almacen.asset_id, {
      UpdateExpression: 'SET cantidad = cantidad + :c, actualizado_en = :now',
      ExpressionAttributeValues: { ':c': qty, ':now': ahora() },
    });
    await putEvento(itemEvento({
      assetId: almacen.asset_id,
      eventoId: nuevoId(),
      tipo: EVENTO.devolucion,
      usuario: actor,
      antes: { cantidad: almacen.cantidad },
      despues: { cantidad: almacen.cantidad + qty, desde: origen.asset_id },
      notas: texto(notas) || null,
    }));
  } else {
    destino = await crearLoteDerivado(origen, {
      cantidad: qty,
      estado: ESTADO.en_almacen,
      custodio: null,
      actor,
      tipoEvento: EVENTO.devolucion,
      despues: { cantidad: qty, desde: origen.asset_id, id_local: origen.id_local },
      notas,
    });
  }
  await restarCantidadLote(origen, qty, actor, EVENTO.devolucion, notas, { hacia: 'almacen' });
  return publicActivo(destino);
}

function parseLineasCustodia(body) {
  const lineas = Array.isArray(body?.lineas) ? body.lineas : [];
  if (!lineas.length) throw errorHttp(400, 'Indica al menos una prenda');
  const vistos = new Set();
  return lineas.map((linea) => {
    const assetId = texto(linea?.asset_id);
    if (!esUuid(assetId)) throw errorHttp(400, 'Hay una prenda sin identificar');
    if (vistos.has(assetId)) throw errorHttp(400, 'Hay prendas repetidas');
    vistos.add(assetId);
    const raw = linea?.cantidad;
    const cantidad = raw == null || raw === '' ? null : Number(raw);
    if (cantidad != null && (!Number.isInteger(cantidad) || cantidad < 1)) {
      throw errorHttp(400, 'La cantidad debe ser al menos 1');
    }
    const bruto = linea?.local_imputado_id;
    const localImputadoId = bruto == null || bruto === '' ? '' : idLocalNorm(bruto);
    if (bruto != null && bruto !== '' && !localImputadoId) {
      throw errorHttp(400, 'El local al que se imputa la prenda no es válido');
    }
    return { assetId, cantidad, localImputadoId };
  });
}

export async function entregarActivos(user, body) {
  const empleado = await cargarEmpleado(body?.employee_id, { exigirActivo: true });
  const actor = actorDe(user);
  const notas = body?.notas;
  const creados = [];
  for (const linea of parseLineasCustodia(body)) {
    if (!linea.localImputadoId) throw errorHttp(400, 'Indica el local al que se factura cada prenda');
    const origen = await exigirActivoVisible(user, linea.assetId);
    const imputado = await asegurarLocalAccesible(user, linea.localImputadoId);
    const qty = origen.granularidad === GRANULARIDAD.lote
      ? (linea.cantidad ?? unidadesDe(origen))
      : 1;
    creados.push(await entregarUnaLinea(user, origen, empleado, qty, actor, notas, imputado));
  }
  return { employee_id: empleado.id, employee_nombre: empleado.nombre, activos: creados };
}

export async function devolverActivos(user, body) {
  const empleado = await cargarEmpleado(body?.employee_id, { exigirActivo: false });
  const actor = actorDe(user);
  const notas = body?.notas;
  const creados = [];
  for (const linea of parseLineasCustodia(body)) {
    const origen = await exigirActivoVisible(user, linea.assetId);
    const qty = origen.granularidad === GRANULARIDAD.lote
      ? (linea.cantidad ?? unidadesDe(origen))
      : 1;
    creados.push(await devolverUnaLinea(user, origen, empleado, qty, actor, notas));
  }
  return { employee_id: empleado.id, employee_nombre: empleado.nombre, activos: creados };
}

function resumenCustodiaDe(items) {
  const por = new Map();
  for (const it of items) {
    const id = String(it.custodio_id || '');
    if (!id) continue;
    if (!por.has(id)) {
      por.set(id, {
        employee_id: id,
        employee_nombre: texto(it.custodio_nombre) || id,
        cantidad: 0,
        activos: [],
      });
    }
    const grupo = por.get(id);
    grupo.cantidad += unidadesDe(it);
    grupo.activos.push(it);
  }
  return [...por.values()].sort((a, b) => a.employee_nombre.localeCompare(b.employee_nombre, 'es'));
}

async function articulosEnCustodia(items) {
  const articulos = agruparCustodiaPorArticulo(items);
  const fotosModelo = await clavesFotoModelo(articulos.map((a) => a.modelo_id));
  return Promise.all(articulos.map(async ({ foto_s3_key: clave, ...art }) => {
    const key = clave || fotosModelo.get(art.modelo_id) || null;
    return {
      ...art,
      foto_url: key ? await urlFirmadaLectura(key) : null,
    };
  }));
}

export async function servicioCustodias(user, query) {
  const employeeId = texto(query.employee_id);
  const modeloId = texto(query.modelo_id);
  const porArticulo = texto(query.agrupar).toLowerCase() === 'articulo';
  const permitidos = await idsLocalesPermitidos(user);
  let items = await listarTodosAsignados();
  items = filtrarPorAlcance(items, permitidos);
  if (employeeId) items = items.filter((it) => String(it.custodio_id) === employeeId);
  if (modeloId) {
    if (!esUuid(modeloId)) throw errorHttp(400, 'Modelo no válido');
    items = items.filter((it) => it.modelo_id === modeloId);
  }
  if (porArticulo) return { articulos: await articulosEnCustodia(items) };
  const custodias = resumenCustodiaDe(items);
  const pub = await Promise.all(custodias.map(async (c) => ({
    ...c,
    activos: await publicActivosListado(c.activos),
  })));
  if (employeeId) {
    const uno = pub[0] || { employee_id: employeeId, employee_nombre: '', cantidad: 0, activos: [] };
    return uno;
  }
  return { custodias: pub };
}

async function aplicarCambioEstado(actual, estado, actor, notas, tipoEvento = EVENTO.cambio_estado) {
  const permitidos = TRANSICIONES[actual.estado] || [];
  if (!permitidos.includes(estado)) {
    throw errorHttp(422, `No se puede pasar de «${actual.estado}» a «${estado}»`);
  }
  const gse = claveEstadoCatEtiqueta(estado, actual.categoria_id, actual.etiqueta_legible);
  const sets = [
    'estado = :est',
    'actualizado_en = :now',
    'gsi_estado_cat_etiqueta = :gse',
  ];
  const values = { ':est': estado, ':now': ahora(), ':gse': gse };
  let remove = '';
  if (estado === ESTADO.baja) {
    remove = ' REMOVE gsi_listado, custodio_id, custodio_tipo, custodio_nombre, asignado_en';
  } else if (estado === ESTADO.perdido && actual.custodio_id) {
    remove = ' REMOVE custodio_id, custodio_tipo, custodio_nombre, asignado_en';
  } else if (!actual.gsi_listado) {
    sets.push('gsi_listado = :gl');
    values[':gl'] = GSI_LISTADO_ACTIVO;
  }
  const updated = await updateActivo(actual.asset_id, {
    UpdateExpression: `SET ${sets.join(', ')}${remove}`,
    ExpressionAttributeValues: values,
  });
  await putEvento(itemEvento({
    assetId: actual.asset_id,
    eventoId: nuevoId(),
    tipo: tipoEvento,
    usuario: actor,
    antes: { estado: actual.estado },
    despues: { estado },
    notas: texto(notas) || null,
  }));
  return updated;
}

async function aplicarBaja(actual, actor, notas) {
  return aplicarCambioEstado(actual, ESTADO.baja, actor, notas, EVENTO.baja);
}

export async function cambiarEstado(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  const estado = texto(body?.estado);
  if (!enLista(ESTADOS_ACTIVO, estado)) throw errorHttp(400, 'Estado no válido');
  if (estado === ESTADO.baja) throw errorHttp(400, 'La baja se hace por su propia acción');
  if (estado === ESTADO.asignado) throw errorHttp(400, 'Para asignar, entrega el activo a un trabajador');
  if (actual.estado === ESTADO.asignado || actual.custodio_id) {
    if (estado === ESTADO.perdido || estado === ESTADO.baja) {
      const updated = await aplicarCambioEstado(actual, estado, actorDe(user), body?.notas);
      return publicActivo(updated);
    }
    throw errorHttp(400, 'Para quitarlo del trabajador, usa la devolución');
  }
  const updated = await aplicarCambioEstado(actual, estado, actorDe(user), body?.notas);
  return publicActivo(updated);
}

export async function darDeBaja(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  const updated = await aplicarBaja(actual, actorDe(user), body?.notas);
  return publicActivo(updated);
}

export async function marcarPerdido(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  const updated = await aplicarCambioEstado(actual, ESTADO.perdido, actorDe(user), body?.notas);
  return publicActivo(updated);
}

export async function sustituirUnidad(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  if (actual.estado === ESTADO.baja) throw errorHttp(409, 'Un activo dado de baja no se puede sustituir');
  const serie = normalizarSerie(body?.numero_serie);
  if (!serie) throw errorHttp(400, 'Indica el nuevo número de serie');
  const actor = actorDe(user);
  const sets = ['numero_serie = :ns', 'numero_serie_norm = :nsn', 'actualizado_en = :now'];
  const values = { ':ns': serie, ':nsn': serie, ':now': ahora() };
  const updated = await updateActivo(assetId, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeValues: values,
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.sustitucion_unidad,
    usuario: actor,
    antes: { numero_serie: actual.numero_serie ?? null },
    despues: { numero_serie: serie },
    notas: texto(body?.notas) || null,
  }));
  return publicActivo(updated);
}

// ─── Fotos ───

export async function presignFoto(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  if ((actual.fotos || []).length >= FOTOS_MAX) {
    throw errorHttp(400, `Como máximo ${FOTOS_MAX} fotos por activo`);
  }
  const tipo = texto(body?.tipo) || 'general';
  if (!enLista(TIPOS_FOTO, tipo)) throw errorHttp(400, 'Tipo de foto no válido');
  const fotoId = nuevoId();
  return presignarSubida({
    assetId,
    fotoId,
    contentType: body?.content_type,
  });
}

export async function confirmarFoto(user, assetId, body) {
  const actual = await exigirActivoVisible(user, assetId);
  const s3Key = texto(body?.s3_key);
  const fotoId = texto(body?.foto_id);
  const tipo = texto(body?.tipo) || 'general';
  if (!s3Key || !fotoId) throw errorHttp(400, 'Faltan s3_key o foto_id');
  if (!clavePerteneceAlActivo(s3Key, assetId)) throw errorHttp(400, 'La clave de fichero no pertenece a este activo');
  if (!enLista(TIPOS_FOTO, tipo)) throw errorHttp(400, 'Tipo de foto no válido');
  if ((actual.fotos || []).some((f) => f.foto_id === fotoId || f.s3_key === s3Key)) {
    throw errorHttp(409, 'Esa foto ya está registrada');
  }
  const foto = { foto_id: fotoId, tipo, s3_key: s3Key, creado_en: ahora() };
  const fotos = [...(actual.fotos || []), foto];
  const updated = await updateActivo(assetId, {
    UpdateExpression: 'SET fotos = :f, actualizado_en = :now',
    ExpressionAttributeValues: { ':f': fotos, ':now': ahora() },
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.foto_añadida,
    usuario: actorDe(user),
    despues: { foto_id: fotoId, tipo },
    fotos: [{ s3_key: s3Key, tipo }],
  }));
  const urls = await urlsFirmadasDeFotos(updated.fotos);
  return publicActivo(updated, urls);
}

export async function borrarFoto(user, assetId, fotoId) {
  const actual = await exigirActivoVisible(user, assetId);
  const foto = (actual.fotos || []).find((f) => f.foto_id === fotoId);
  if (!foto) throw errorHttp(404, 'Foto no encontrada');
  await borrarObjeto(foto.s3_key);
  const fotos = (actual.fotos || []).filter((f) => f.foto_id !== fotoId);
  const updated = await updateActivo(assetId, {
    UpdateExpression: 'SET fotos = :f, actualizado_en = :now',
    ExpressionAttributeValues: { ':f': fotos, ':now': ahora() },
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.edicion,
    usuario: actorDe(user),
    antes: { foto_id: fotoId },
    despues: { foto_eliminada: true },
  }));
  const urls = await urlsFirmadasDeFotos(updated.fotos);
  return publicActivo(updated, urls);
}

export async function urlFoto(user, assetId, fotoId) {
  const actual = await exigirActivoVisible(user, assetId);
  const foto = (actual.fotos || []).find((f) => f.foto_id === fotoId);
  if (!foto) throw errorHttp(404, 'Foto no encontrada');
  const url = await urlFirmadaLectura(foto.s3_key);
  return { url, foto_id: fotoId };
}

// ─── Etiquetas ───

function payloadEtiqueta(item, categoria) {
  const base = texto(process.env.ACTIVOS_QR_BASE_URL || '').replace(/\/+$/, '');
  return {
    asset_id: item.asset_id,
    etiqueta_legible: item.etiqueta_legible,
    marca: item.marca,
    nombre_modelo: item.nombre_modelo,
    numero_serie: item.numero_serie,
    formato_etiqueta: categoria?.formato_etiqueta || 'completa',
    ya_impresa: item.etiqueta_impresa === true,
    qr_url: base ? `${base}/a/${item.asset_id}` : `/a/${item.asset_id}`,
  };
}

export async function previewEtiquetas(user, assetIds) {
  const ids = Array.isArray(assetIds) ? assetIds.filter((id) => esUuid(id)) : [];
  if (!ids.length) throw errorHttp(400, 'Indica al menos un activo');
  const out = [];
  for (const id of ids) {
    const item = await exigirActivoVisible(user, id);
    const cat = await getCategoria(item.categoria_id);
    out.push(payloadEtiqueta(item, cat));
  }
  return { etiquetas: out };
}

export async function marcarImpresas(user, assetIds) {
  const ids = Array.isArray(assetIds) ? assetIds.filter((id) => esUuid(id)) : [];
  if (!ids.length) throw errorHttp(400, 'Indica al menos un activo');
  const actor = actorDe(user);
  const now = ahora();
  const actualizados = [];
  for (const id of ids) {
    const item = await exigirActivoVisible(user, id);
    const updated = await updateActivo(id, {
      UpdateExpression: 'SET etiqueta_impresa = :si, etiqueta_impresa_en = :now, actualizado_en = :now',
      ExpressionAttributeValues: { ':si': true, ':now': now },
    });
    await putEvento(itemEvento({
      assetId: id,
      eventoId: nuevoId(),
      tipo: EVENTO.etiqueta_impresa,
      usuario: actor,
      despues: { etiqueta_impresa: true },
    }));
    actualizados.push(publicActivo(updated));
  }
  return { activos: actualizados };
}

export async function verificarEtiqueta(user, assetId) {
  const actual = await exigirActivoVisible(user, assetId);
  const actor = actorDe(user);
  const updated = await updateActivo(assetId, {
    UpdateExpression:
      'SET etiqueta_verificada = :si, etiqueta_verificada_en = :now, etiqueta_verificada_por = :u, actualizado_en = :now',
    ExpressionAttributeValues: { ':si': true, ':now': ahora(), ':u': actor.id },
  });
  await putEvento(itemEvento({
    assetId,
    eventoId: nuevoId(),
    tipo: EVENTO.etiqueta_verificada,
    usuario: actor,
    despues: { etiqueta_verificada: true },
  }));
  return publicActivo(updated);
}

