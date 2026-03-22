/**
 * Validación dura de importes, saneado de número de factura y metadatos de revisión
 * para el pipeline OCR / IA (registro masivo).
 */

import {
  debeUsarAgregadosDesglose,
  normalizarLineasDesgloseDesdeInput,
  validarCoherenciaDesglose,
} from './ocrFacturaDesglose.js';

export const TOLERANCIA_IMPORTES = 0.02;

export function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function validarCoherenciaImportes(base, iva, ret, total, tol = TOLERANCIA_IMPORTES) {
  const b = Number(base) || 0;
  const i = Number(iva) || 0;
  const r = Number(ret) || 0;
  const t = Number(total) || 0;
  const esperado = round2(b + i - r);
  const diferencia = round2(t - esperado);
  const ok = t > 0 && Math.abs(diferencia) <= tol;
  return {
    ok,
    importes_coherentes: ok,
    diferencia_importes: diferencia,
    total_esperado: esperado,
    formula_usada: 'base + total_iva - retencion ≈ total_factura',
  };
}

export function sanitizarNumeroFacturaProveedor(raw) {
  const original = String(raw || '').trim();
  if (!original) return { limpio: '', original: '', fue_normalizado: false };

  const collapsed = original.replace(/\s+/g, ' ');
  const tokens = collapsed.split(/\s+/).filter(Boolean);

  const tryToken = (token) => {
    const clean = token.replace(/^[^\w\-\/]+|[^\w\-\/]+$/g, '');
    if (clean.length < 4 || clean.length > 36) return null;
    if (/^\d{5,8}$/.test(clean)) return null;
    if (clean.length > 12 && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]+$/i.test(clean)) return null;
    if (/^[A-Za-z]{1,5}\d{3,}[A-Za-z0-9\-\/]*$/i.test(clean) && /\d/.test(clean)) return clean;
    if (/^[A-Za-z0-9]+[\/\-][A-Za-z0-9\/\-]+$/i.test(clean)) return clean;
    if (/^\d{4}[\/\-]\d{3,}$/.test(clean)) return clean;
    if (/^[A-Za-z]{1,3}[\-\/]?\d{4,}$/i.test(clean)) return clean;
    return null;
  };

  for (const t of tokens) {
    const hit = tryToken(t);
    if (hit) return { limpio: hit, original, fue_normalizado: hit !== original };
  }

  if (tokens[0]) {
    const t = tokens[0].replace(/[^\w\-\/]/g, '');
    if (t.length >= 4 && t.length <= 28) return { limpio: t, original, fue_normalizado: t !== original };
  }

  return { limpio: original.slice(0, 32).trim(), original, fue_normalizado: false };
}

export function retencionSospechosaDuplicadoIva(base, iva, ret, texto) {
  const b = Number(base) || 0;
  const i = Number(iva) || 0;
  const r = Number(ret) || 0;
  if (b <= 0 || i <= 0 || r <= 0) return { sospechosa: false, motivo: '', retencion_ajustada: r };
  const txt = String(texto || '');
  const tieneExplicita =
    /\bretenci[oó]n\b|\birpf\b|ret\.?\s*profesional|cuota\s*retenci/i.test(txt);
  if (tieneExplicita) return { sospechosa: false, motivo: '', retencion_ajustada: r };

  if (Math.abs(r - i) < 0.06 && Math.abs(i - b * 0.21) < Math.max(2, b * 0.03)) {
    return {
      sospechosa: true,
      motivo:
        'Retención numéricamente igual al IVA sin etiqueta clara de IRPF/retención (posible lectura errónea)',
      retencion_ajustada: 0,
    };
  }
  return { sospechosa: false, motivo: '', retencion_ajustada: r };
}

function nivelToScore(level) {
  if (level === 'alta') return 0.85;
  if (level === 'media') return 0.55;
  return 0.25;
}

export function averageOcrConfidenceFromLevels(conf) {
  const vals = Object.values(conf).filter((v) => typeof v === 'string');
  if (!vals.length) return 0;
  const sum = vals.reduce((a, v) => a + nivelToScore(v), 0);
  return Math.round((sum / vals.length) * 100) / 100;
}

export function degradarConfianzaSiImportesIncoherentes(conf, validacion) {
  if (validacion.ok) return { ...conf };
  const next = { ...conf };
  const bajar = (k) => {
    if (next[k] === 'alta') next[k] = 'media';
    else next[k] = 'baja';
  };
  bajar('total');
  bajar('base_imponible');
  bajar('total_iva');
  if (next.retencion) bajar('retencion');
  return next;
}

export function construirOcrPipelineMeta({
  validacion,
  numeroSan,
  retSospecha,
  motivosExtra = [],
  tiene_desglose_multiple = false,
  total_calculado_desde_desglose,
  ambiguedad_proveedor = false,
}) {
  const motivos = [...motivosExtra];
  if (!validacion.ok) {
    motivos.push(
      `Importes no cuadran: diferencia ${validacion.diferencia_importes} € (esperado ${validacion.total_esperado} €)`,
    );
  }
  if (numeroSan?.fue_normalizado) motivos.push('Nº factura normalizado (se eliminaron datos colindantes)');
  if (retSospecha?.sospechosa && retSospecha.motivo) motivos.push(retSospecha.motivo);
  if (ambiguedad_proveedor) motivos.push('Varios CIF candidatos a proveedor — revisar emisor vs cliente');

  const revision_obligatoria = !validacion.ok || Boolean(ambiguedad_proveedor);
  const revision_sugerida = motivos.length > 0;

  return {
    importes_coherentes: validacion.importes_coherentes,
    diferencia_importes: validacion.diferencia_importes,
    total_esperado_segun_formula: validacion.total_esperado,
    formula_usada: validacion.formula_usada,
    tiene_desglose_multiple: Boolean(tiene_desglose_multiple),
    total_calculado_desde_desglose:
      total_calculado_desde_desglose != null && Number.isFinite(Number(total_calculado_desde_desglose))
        ? round2(Number(total_calculado_desde_desglose))
        : undefined,
    numero_factura_original: numeroSan?.original ?? '',
    numero_factura_limpiado: numeroSan?.limpio ?? '',
    numero_factura_fue_normalizado: Boolean(numeroSan?.fue_normalizado),
    retencion_sospechosa: Boolean(retSospecha?.sospechosa),
    revision_obligatoria,
    revision_sugerida,
    motivos_revision: motivos,
  };
}

/**
 * Saneado de nº factura, retención sospechosa y validación de importes sobre un objeto plano tipo extraerDatosBasicos.
 * Mutación controlada de campos numéricos y de texto.
 */
export function aplicarPostProcesadoPipeline(datos, textoExtraido) {
  const text = String(textoExtraido || '');
  let base = round2(Number(datos.base_imponible) || 0);
  let totalIva = round2(Number(datos.total_iva) || 0);
  let ret = round2(Number(datos.retencion) || 0);
  let total = round2(Number(datos.total_factura) || 0);
  const rawNum = String(datos.numero_factura_proveedor || '').trim();
  const numeroSan = sanitizarNumeroFacturaProveedor(rawNum);

  if (numeroSan.limpio) {
    datos.numero_factura_proveedor = numeroSan.limpio;
  }

  const desgloseLineas = normalizarLineasDesgloseDesdeInput(
    Array.isArray(datos.desglose_impuestos) ? datos.desglose_impuestos : [],
  );
  if (desgloseLineas.length) datos.desglose_impuestos = desgloseLineas;

  const multiFiscal = debeUsarAgregadosDesglose(desgloseLineas);
  const skipRetSusp =
    multiFiscal || desgloseLineas.some((l) => l.tipo === 'recargo_equivalencia');

  let retChk = { sospechosa: false, motivo: '', retencion_ajustada: ret };
  if (!skipRetSusp) {
    retChk = retencionSospechosaDuplicadoIva(base, totalIva, ret, text);
    if (retChk.sospechosa) {
      ret = round2(retChk.retencion_ajustada);
      datos.retencion = ret;
    }
  }

  let validacion;
  if (multiFiscal && desgloseLineas.length > 0) {
    validacion = validarCoherenciaDesglose(desgloseLineas, total);
  } else {
    validacion = validarCoherenciaImportes(base, totalIva, ret, total);
    if (!validacion.ok && base > 0 && totalIva >= 0 && ret >= 0) {
      const recalcTotal = round2(base + totalIva - ret);
      if (Math.abs(recalcTotal - total) > TOLERANCIA_IMPORTES && recalcTotal > 0) {
        total = recalcTotal;
        datos.total_factura = total;
        validacion = validarCoherenciaImportes(base, totalIva, ret, total);
      }
    }
  }

  let conf = datos.confianza && typeof datos.confianza === 'object' ? { ...datos.confianza } : {};
  if (!validacion.ok) {
    conf = degradarConfianzaSiImportesIncoherentes(conf, validacion);
    datos.confianza = conf;
  }

  datos.importes_coherentes = validacion.importes_coherentes;

  const ocr_pipeline_meta = construirOcrPipelineMeta({
    validacion,
    numeroSan,
    retSospecha: retChk,
    motivosExtra: [],
    tiene_desglose_multiple: multiFiscal && desgloseLineas.length > 0,
    total_calculado_desde_desglose:
      multiFiscal && validacion.total_calculado_desde_desglose != null
        ? validacion.total_calculado_desde_desglose
        : undefined,
    ambiguedad_proveedor: Boolean(datos.ambiguedad_proveedor),
  });

  datos.ocr_confianza_global = averageOcrConfidenceFromLevels(conf);

  if (datos.extraction_snapshot && typeof datos.extraction_snapshot === 'object') {
    datos.extraction_snapshot = {
      ...datos.extraction_snapshot,
      proveedor_cif: datos.proveedor_cif,
      numero_factura_proveedor: datos.numero_factura_proveedor,
      fecha_emision: datos.fecha_emision,
      base_imponible: datos.base_imponible,
      total_iva: datos.total_iva,
      retencion: datos.retencion,
      total_factura: datos.total_factura,
      confianza: datos.confianza,
      desglose_impuestos: datos.desglose_impuestos,
      desglose_parse_meta: datos.desglose_parse_meta,
      base_imponible_total: datos.base_imponible_total,
      recargo_equivalencia_total: datos.recargo_equivalencia_total,
    };
  }

  datos.ocr_pipeline_meta = ocr_pipeline_meta;

  return { datos, ocr_pipeline_meta };
}
