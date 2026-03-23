/**
 * Capa opcional de enriquecimiento con modelo LLM sobre datos ya extraídos (OCR/PDF).
 * Requiere OPENAI_API_KEY en el entorno del API.
 */
import { normalizeCif } from './empresaCif.js';
import {
  validarCoherenciaImportes,
  round2,
  sanitizarNumeroFacturaProveedor,
  averageOcrConfidenceFromLevels,
  degradarConfianzaSiImportesIncoherentes,
} from './ocrFacturaValidacion.js';
import {
  agregarResumenDesdeDesglose,
  debeUsarAgregadosDesglose,
  normalizarLineasDesgloseDesdeInput,
  validarCoherenciaDesglose,
} from './ocrFacturaDesglose.js';

const MAX_TEXT_CHARS = 14000;
const DEFAULT_MODEL = process.env.OCR_IA_MODEL || 'gpt-4o-mini';

/** Umbral campos críticos (CIF, nº factura, fecha, total): solo sustituir si confianza IA >= esto */
const UMBRAL_CRITICO = 0.78;
/** Umbral campos corregibles (base, iva, retención) */
const UMBRAL_CORREGIBLE = 0.52;
/** Umbral nombre proveedor (sugestivo) */
const UMBRAL_SUGESTIVO = 0.62;

function floatToNivel(p) {
  if (p >= 0.72) return 'alta';
  if (p >= 0.42) return 'media';
  return 'baja';
}

function averageOcrConfidence(conf) {
  const vals = Object.values(conf).filter((v) => typeof v === 'string');
  if (!vals.length) return 0;
  const toScore = (level) => {
    if (level === 'alta') return 0.85;
    if (level === 'media') return 0.55;
    return 0.25;
  };
  const sum = vals.reduce((a, v) => a + toScore(v), 0);
  return Math.round((sum / vals.length) * 100) / 100;
}

export async function enriquecerFacturaOcrConOpenAI(datos, textoExtraido) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || String(apiKey).trim() === '') {
    throw new Error('OPENAI_API_KEY no configurada');
  }

  const text = String(textoExtraido || '').slice(0, MAX_TEXT_CHARS);
  const payload = {
    extraccion_actual: {
      proveedor_cif: datos.proveedor_cif ?? '',
      proveedor_nombre: datos.proveedor_nombre ?? '',
      numero_factura_proveedor: datos.numero_factura_proveedor ?? '',
      fecha_emision: datos.fecha_emision ?? '',
      base_imponible: datos.base_imponible ?? 0,
      total_iva: datos.total_iva ?? 0,
      retencion: datos.retencion ?? 0,
      total_factura: datos.total_factura ?? 0,
      importes_coherentes: datos.importes_coherentes,
    },
    texto_factura: text,
  };

  const system = `Eres un experto en facturas de gasto en España (IVA, recargo equivalencia R.E., retención IRPF).
Devuelve UN ÚNICO JSON (sin markdown). Reglas estrictas:

IDENTIDAD
- proveedor/emisor ≠ cliente/receptor. El CIF y nombre de proveedor deben corresponder al EMISOR/VENDEDOR del documento, NUNCA al bloque "Cliente", "Destinatario", "Datos del cliente", "Receptor".
- Si no puedes identificar el emisor con claridad, usa proveedor_cif y proveedor_nombre vacíos ("") y baja la confianza.

NÚMERO DE FACTURA
- numero_factura_proveedor: SOLO el identificador de factura del emisor (ej. AA976843, F-2026/001). NUNCA códigos de cliente, códigos numéricos cortos sueltos, ni nombres de empresa del cliente.
- Si el OCR mezcló tokens, devuelve solo el token que encaja con el patrón de factura del proveedor.

IMPORTES (simples)
- base_imponible, total_iva, retencion, total_factura: números. Usa null solo si no hay dato fiable.
- retención: SOLO si hay evidencia explícita de IRPF/retención profesional. NUNCA confundas recargo equivalencia (%R.E., Imp. R.E.) con retención.
- coherencia_importes: true si los importes simples cuadran (tolerancia 1 €) O si usas desglose y cuadra la fórmula de desglose.

DESGLOSE FISCAL (opcional, si hay varios tramos)
- desglose_impuestos: array de { "tipo": "iva"|"retencion"|"recargo_equivalencia", "base": number, "porcentaje": number|null, "cuota": number }.
- R.E. siempre tipo recargo_equivalencia, nunca retencion.
- Si no ves líneas fiables, devuelve [] y no inventes.
- recargo_equivalencia_total: número (suma cuotas R.E.) si aplica, si no 0.

CONFIANZA
- confianza_campos: 0..1 por campo. Baja confianza si hay ambigüedad o datos ausentes.
- motivos_revision: array de strings en español (vacío si no hay dudas).
- tipo_documento: "factura_completa" | "simplificada" | "ticket" | "abono" | "desconocido"

No inventes CIFs ni importes que no puedas fundamentar en el texto.`;

  const user = JSON.stringify(payload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        temperature: 0.05,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Respuesta OpenAI vacía');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('JSON inválido en respuesta IA');
  }

  return normalizeIaResponse(parsed);
}

function numOrZero(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : 0;
}

function normalizeIaResponse(raw) {
  const cc = raw.confianza_campos && typeof raw.confianza_campos === 'object' ? raw.confianza_campos : {};
  const getf = (k, def = 0.5) => {
    const v = Number(cc[k]);
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : def;
  };

  const desglose_ia = normalizarLineasDesgloseDesdeInput(raw.desglose_impuestos);

  return {
    proveedor_cif: raw.proveedor_cif != null ? String(raw.proveedor_cif).trim() : '',
    proveedor_nombre: raw.proveedor_nombre != null ? String(raw.proveedor_nombre).trim() : '',
    numero_factura_proveedor:
      raw.numero_factura_proveedor != null ? String(raw.numero_factura_proveedor).trim() : '',
    fecha_emision: raw.fecha_emision != null ? String(raw.fecha_emision).trim() : '',
    base_imponible: numOrZero(raw.base_imponible),
    total_iva: numOrZero(raw.total_iva),
    retencion: numOrZero(raw.retencion),
    total_factura: numOrZero(raw.total_factura),
    recargo_equivalencia_total: numOrZero(raw.recargo_equivalencia_total),
    desglose_impuestos: desglose_ia,
    confianza_campos: {
      proveedor_cif: getf('proveedor_cif'),
      proveedor_nombre: getf('proveedor_nombre'),
      numero_factura_proveedor: getf('numero_factura_proveedor'),
      fecha_emision: getf('fecha_emision'),
      base_imponible: getf('base_imponible'),
      total_iva: getf('total_iva'),
      retencion: getf('retencion'),
      total_factura: getf('total_factura'),
    },
    coherencia_importes: Boolean(raw.coherencia_importes),
    motivos_revision: Array.isArray(raw.motivos_revision)
      ? raw.motivos_revision.map((s) => String(s)).filter(Boolean)
      : [],
    tipo_documento: String(raw.tipo_documento || 'desconocido'),
  };
}

/**
 * Fusiona IA con datos originales: campos críticos solo con alta confianza y sin empeorar coherencia.
 */
export function mergeExtraccionConIa(datosOriginales, ia) {
  const base = { ...datosOriginales };
  const c = ia.confianza_campos;
  const p = (k, def = 0.5) => (c[k] != null && Number.isFinite(Number(c[k])) ? Number(c[k]) : def);

  const origDes = normalizarLineasDesgloseDesdeInput(datosOriginales.desglose_impuestos || []);
  const iaDes = normalizarLineasDesgloseDesdeInput(ia.desglose_impuestos || []);

  const valOrig = validarCoherenciaImportes(
    base.base_imponible,
    base.total_iva,
    base.retencion,
    base.total_factura,
  );
  const valOrigDesg =
    origDes.length > 0 ? validarCoherenciaDesglose(origDes, Number(datosOriginales.total_factura) || 0) : null;
  const valIaDes =
    iaDes.length > 0 ? validarCoherenciaDesglose(iaDes, round2(ia.total_factura)) : null;

  if (ia.proveedor_cif && p('proveedor_cif') >= UMBRAL_CRITICO) {
    const norm = normalizeCif(String(ia.proveedor_cif));
    if (norm || String(ia.proveedor_cif).trim().length >= 8) {
      base.proveedor_cif = norm || String(ia.proveedor_cif).trim();
    }
  } else if (ia.proveedor_cif && p('proveedor_cif') >= UMBRAL_CORREGIBLE && !datosOriginales.proveedor_cif) {
    const norm = normalizeCif(String(ia.proveedor_cif));
    if (norm) base.proveedor_cif = norm;
  }

  if (ia.proveedor_nombre && p('proveedor_nombre') >= UMBRAL_SUGESTIVO) {
    base.proveedor_nombre = String(ia.proveedor_nombre).trim();
  }

  if (ia.numero_factura_proveedor && p('numero_factura_proveedor') >= UMBRAL_CRITICO) {
    const san = sanitizarNumeroFacturaProveedor(String(ia.numero_factura_proveedor));
    base.numero_factura_proveedor = san.limpio || String(ia.numero_factura_proveedor).trim();
  } else if (ia.numero_factura_proveedor && p('numero_factura_proveedor') >= UMBRAL_CORREGIBLE) {
    const san = sanitizarNumeroFacturaProveedor(String(ia.numero_factura_proveedor));
    if (san.limpio && san.limpio.length <= 36) base.numero_factura_proveedor = san.limpio;
  }

  if (ia.fecha_emision && p('fecha_emision') >= UMBRAL_CORREGIBLE) {
    base.fecha_emision = String(ia.fecha_emision).trim();
  }

  const probarImportesIa = () => {
    const bi = round2(ia.base_imponible);
    const iv = round2(ia.total_iva);
    const re = round2(ia.retencion);
    const tf = round2(ia.total_factura);
    return validarCoherenciaImportes(bi, iv, re, tf);
  };

  const valIa = probarImportesIa();
  const avgImp =
    (p('base_imponible') + p('total_iva') + p('retencion') + p('total_factura')) / 4;

  let aplicarImportes =
    ia.coherencia_importes &&
    valIa.ok &&
    avgImp >= UMBRAL_CORREGIBLE &&
    (p('total_factura') >= UMBRAL_CRITICO || p('base_imponible') >= UMBRAL_CRITICO);

  if (!aplicarImportes && !valOrig.ok && valIa.ok && avgImp >= 0.55) {
    aplicarImportes = true;
  }

  const iaDesgloseAceptable =
    iaDes.length > 0 &&
    valIaDes?.ok &&
    (p('total_factura') >= UMBRAL_CORREGIBLE || p('base_imponible') >= UMBRAL_CORREGIBLE);

  const origMulti = debeUsarAgregadosDesglose(origDes);

  if (iaDesgloseAceptable && (!valOrigDesg?.ok || !origDes.length)) {
    const agg = agregarResumenDesdeDesglose(iaDes);
    base.desglose_impuestos = iaDes;
    base.base_imponible = agg.base_imponible_total;
    base.base_imponible_total = agg.base_imponible_total;
    base.total_iva = agg.iva_total;
    base.retencion = agg.retencion_total;
    base.recargo_equivalencia_total = agg.recargo_equivalencia_total;
    base.total_factura = round2(ia.total_factura);
  } else if (origDes.length > 0) {
    base.desglose_impuestos = origDes;
    base.base_imponible_total =
      datosOriginales.base_imponible_total ?? datosOriginales.base_imponible;
    base.recargo_equivalencia_total = round2(
      Number(datosOriginales.recargo_equivalencia_total) || 0,
    );
  }

  if (aplicarImportes && !iaDesgloseAceptable && !origMulti) {
    base.base_imponible = round2(ia.base_imponible);
    base.total_iva = round2(ia.total_iva);
    base.retencion = round2(ia.retencion);
    base.total_factura = round2(ia.total_factura);
    base.recargo_equivalencia_total = round2(ia.recargo_equivalencia_total);
  } else if (
    !iaDesgloseAceptable &&
    !origMulti &&
    p('base_imponible') >= UMBRAL_CORREGIBLE &&
    p('total_iva') >= UMBRAL_CORREGIBLE &&
    !valOrig.ok
  ) {
    const tryVal = validarCoherenciaImportes(
      round2(ia.base_imponible),
      round2(ia.total_iva),
      round2(ia.retencion),
      round2(ia.total_factura),
    );
    if (tryVal.ok) {
      base.base_imponible = round2(ia.base_imponible);
      base.total_iva = round2(ia.total_iva);
      base.retencion = round2(ia.retencion);
      base.total_factura = round2(ia.total_factura);
      base.recargo_equivalencia_total = round2(ia.recargo_equivalencia_total);
    }
  }

  let confianza = {
    proveedor_cif: floatToNivel(c.proveedor_cif ?? 0.5),
    proveedor_nombre: floatToNivel(c.proveedor_nombre ?? 0.5),
    numero_factura: floatToNivel(c.numero_factura_proveedor ?? 0.5),
    fecha: floatToNivel(c.fecha_emision ?? 0.5),
    total: floatToNivel(c.total_factura ?? 0.5),
    base_imponible: floatToNivel(c.base_imponible ?? 0.5),
    total_iva: floatToNivel(c.total_iva ?? 0.5),
    retencion: floatToNivel(c.retencion ?? 0.5),
  };

  const valPost = validarCoherenciaImportes(
    base.base_imponible,
    base.total_iva,
    base.retencion,
    base.total_factura,
  );
  if (!valPost.ok) {
    confianza = degradarConfianzaSiImportesIncoherentes(confianza, valPost);
  }

  base.confianza = confianza;
  base.ocr_confianza_global = averageOcrConfidence(confianza);
  base.importes_coherentes = valPost.importes_coherentes;

  base.extraction_snapshot = {
    ...(base.extraction_snapshot || {}),
    proveedor_cif: base.proveedor_cif,
    numero_factura_proveedor: base.numero_factura_proveedor,
    fecha_emision: base.fecha_emision,
    base_imponible: base.base_imponible,
    total_iva: base.total_iva,
    retencion: base.retencion,
    total_factura: base.total_factura,
    confianza,
    desglose_impuestos: base.desglose_impuestos,
    base_imponible_total: base.base_imponible_total,
    recargo_equivalencia_total: base.recargo_equivalencia_total,
  };

  const ts = new Date().toISOString();
  const campos_tocados = [];
  if (aplicarImportes || (base.base_imponible !== datosOriginales.base_imponible && valPost.ok))
    campos_tocados.push('importes');
  if (base.proveedor_cif !== datosOriginales.proveedor_cif) campos_tocados.push('proveedor_cif');
  if (base.numero_factura_proveedor !== datosOriginales.numero_factura_proveedor)
    campos_tocados.push('numero_factura_proveedor');

  const desgloseConflict =
    origDes.length > 0 &&
    iaDes.length > 0 &&
    JSON.stringify(origDes) !== JSON.stringify(iaDes) &&
    valOrigDesg?.ok &&
    valIaDes?.ok;

  const lineasPost = normalizarLineasDesgloseDesdeInput(base.desglose_impuestos || []);

  base.ia_meta = {
    aplicada: true,
    modelo: DEFAULT_MODEL,
    enriquecido_en: ts,
    tipo_documento: ia.tipo_documento,
    tiene_desglose_multiple: debeUsarAgregadosDesglose(lineasPost),
    desglose_aceptado_desde: iaDesgloseAceptable ? 'ia' : origDes.length ? 'ocr' : undefined,
    desglose_conflicto_ocr_ia: Boolean(desgloseConflict),
    revision_sugerida:
      !valPost.importes_coherentes ||
      (ia.motivos_revision && ia.motivos_revision.length > 0) ||
      !ia.coherencia_importes ||
      Boolean(desgloseConflict),
    revision_obligatoria: !valPost.importes_coherentes,
    motivos: ia.motivos_revision || [],
    coherencia_importes: valPost.importes_coherentes,
    diferencia_importes: valPost.diferencia_importes,
    campos_corregidos_ia: campos_tocados,
    coherencia_declarada_ia: ia.coherencia_importes,
    cambios_rechazados_ia: desgloseConflict
      ? ['Desglose OCR e IA distintos — revisar líneas fiscales']
      : [],
  };

  base.proveedor_resuelto_por = base.proveedor_resuelto_por || 'extraccion_ia';

  return base;
}

export function isIaEnriquecimientoDisponible() {
  return Boolean(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim());
}
