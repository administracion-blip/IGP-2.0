/**
 * Extracción de entidades (CIF), parseo de factura con retención y reconciliación emisor/receptor.
 * La lógica fuerte vive aquí; facturacion.js solo conecta I/O (BD, HTTP).
 */

import { normalizeCif, cifDigitsOnly } from './empresaCif.js';
import {
  parseDesgloseFiscalFromText,
  agregarResumenDesdeDesglose,
  debeUsarAgregadosDesglose,
  validarCoherenciaDesglose,
  totalEsperadoDesdeDesglose,
  usarValidacionDesgloseMultiple,
} from './ocrFacturaDesglose.js';

export const RECEPTOR_LABELS_CTX =
  /\b(cliente|destinatario|adquiriente|receptor|facturar\s*a|bill\s*to|ship\s*to|comprador|datos\s*del?\s*cliente)\b/i;
const EMISOR_LABELS_CTX =
  /\b(emisor|proveedor|expedidor|raz[oó]n\s*social|vendedor|datos\s*del?\s*(?:emisor|proveedor))\b/i;
const CONTEXT_RADIUS_CIF = 200;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Misma lógica que en facturacion.js (formato europeo). */
export function normalizeImporteFacturaEsp(raw) {
  if (raw == null || raw === '') return NaN;
  let s = String(raw).trim();
  s = s.replace(/€/g, '').replace(/\u00A0/g, '').replace(/\s+/g, '');
  s = s.replace(/[^\d.,\-]/g, '');
  if (!s || s === '-') return NaN;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > lastDot) {
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  if (lastDot > lastComma && lastComma >= 0) {
    const n = parseFloat(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  if (lastComma !== -1 && lastDot === -1) {
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  }
  if (lastDot !== -1 && lastComma === -1) {
    const parts = s.split('.');
    if (parts.length === 2 && parts[1].length <= 2) {
      return parseFloat(s);
    }
    if (parts.length > 2) {
      const sign = s.startsWith('-') ? -1 : 1;
      const n = parseFloat(s.replace(/^-/, '').split('.').join(''));
      return Number.isFinite(n) ? sign * n : NaN;
    }
    if (parts.length === 2 && parts[1].length === 3) {
      return parseFloat(s.replace('.', ''));
    }
    return parseFloat(s);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function scoreEmisorReceptorEnContexto(text, cif, pos) {
  let score_emisor = 0;
  let score_receptor = 0;
  if (pos < 0) return { score_emisor: 0, score_receptor: 0, pos };

  const ctxStart = Math.max(0, pos - CONTEXT_RADIUS_CIF);
  const ctxEnd = Math.min(text.length, pos + String(cif).length + CONTEXT_RADIUS_CIF);
  const context = text.slice(ctxStart, ctxEnd);

  if (RECEPTOR_LABELS_CTX.test(context)) score_receptor += 10;
  if (EMISOR_LABELS_CTX.test(context)) score_emisor += 10;

  const lower = text.toLowerCase();
  const beforeCif = lower.slice(Math.max(0, pos - 60), pos);
  if (/\b(nif|cif|vat)\s*[:.]?\s*$/i.test(beforeCif)) {
    score_emisor += 2;
    score_receptor += 1;
  }
  const earlyBias = (1 - pos / Math.max(text.length, 1)) * 2;
  score_emisor += earlyBias * 0.3;

  return { score_emisor, score_receptor, pos };
}

export function netEmisorScore(e) {
  return (e.score_emisor ?? 0) - (e.score_receptor ?? 0);
}

function normalizeNombreComparacion(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Umbral alto: Jaccard en tokens > 2 caracteres. */
export function nombreSimilaridadFuerte(a, b) {
  if (!a || !b || a.length < 8 || b.length < 8) return false;
  const ta = a.split(' ').filter((t) => t.length > 2);
  const tb = b.split(' ').filter((t) => t.length > 2);
  if (ta.length === 0 || tb.length === 0) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  const j = union > 0 ? inter / union : 0;
  if (j >= 0.55) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length > b.length ? a : b;
  if (short.length >= 10 && long.includes(short.slice(0, Math.min(12, short.length)))) return true;
  return false;
}

function inferNombreNearCif(text, cif, pos) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cifNorm = String(cif).replace(/\s/g, '');
  const idx = lines.findIndex((l) => l.replace(/\s/g, '').includes(cifNorm));
  if (idx >= 0) {
    for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
      const candidate = lines[i];
      if (
        candidate.length >= 3 &&
        candidate.length < 120 &&
        !/^\d{1,2}[\/\-]/.test(candidate) &&
        !/^[A-Z0-9]{8,}$/i.test(candidate) &&
        !RECEPTOR_LABELS_CTX.test(candidate) &&
        !/^\d+[.,]\d{2}\s*€?$/.test(candidate)
      ) {
        return candidate.replace(/^[\s\-–—]+/, '').slice(0, 120);
      }
    }
  }
  const sl = text.slice(Math.max(0, pos - 400), pos + 80).match(
    /([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚáéíóúñ0-9\s.,&\-]{3,80}(?:S\.?L\.?U\.?|S\.?L\.?|S\.?A\.?|S\.?C\.?O\.?O\.?P\.?))\.?/i,
  );
  return sl ? sl[1].trim().replace(/\s+/g, ' ').slice(0, 120) : '';
}

function inferDireccionNearCif(text, cif, pos) {
  const slice = text.slice(Math.max(0, pos - 30), Math.min(text.length, pos + 200));
  const m = slice.match(
    /([A-ZÁÉÍÓÚÑa-záéíóúñ0-9\s.,º°\-]+\d{1,5}[^,\n]*,\s*\d{5}\s+[A-ZÁÉÍÓÚÑa-záéíóúñ\s\-]+)/i,
  );
  if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  const m2 = slice.match(/(C\/|Calle|Av\.?|Avda|Plaza|P\.º)\s+[^,\n]+,\s*\d{1,5}\s*[^,\n]*/i);
  return m2 ? m2[0].trim().slice(0, 200) : '';
}

/**
 * Entidades candidatas (CIF únicos con mejor score neto emisor/receptor).
 */
export function extraerEntidadesCandidatas(text) {
  if (!text || !String(text).trim()) return [];
  const cifRegex = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/gi;
  const seen = new Map();
  let m;
  while ((m = cifRegex.exec(text)) !== null) {
    const cifRaw = m[1].toUpperCase();
    const pos = m.index;
    const scores = scoreEmisorReceptorEnContexto(text, cifRaw, pos);
    const net = scores.score_emisor - scores.score_receptor;
    const prev = seen.get(cifRaw);
    const prevNet = prev ? netEmisorScore(prev) : -999;
    if (!prev || net > prevNet) {
      const ctxStart = Math.max(0, pos - 120);
      const ctxEnd = Math.min(text.length, pos + cifRaw.length + 120);
      seen.set(cifRaw, {
        cif: cifRaw,
        pos,
        score_emisor: scores.score_emisor,
        score_receptor: scores.score_receptor,
        contexto: text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').slice(0, 400),
        nombre_candidato: inferNombreNearCif(text, cifRaw, pos),
        direccion_candidata: inferDireccionNearCif(text, cifRaw, pos),
      });
    }
  }
  const arr = Array.from(seen.values());
  return arr.map((e, i) => {
    const net = netEmisorScore(e);
    let rol_provisional = 'desconocido';
    if (net > 2) rol_provisional = 'emisor';
    else if (net < -2) rol_provisional = 'receptor';
    const cifCanon = normalizeCif(e.cif) || e.cif;
    return {
      id: `ent_${i}_${cifCanon}`,
      cif: cifCanon,
      nombre_candidato: e.nombre_candidato || '',
      direccion_candidata: e.direccion_candidata || '',
      contexto: e.contexto || '',
      score_emisor: round2(e.score_emisor),
      score_receptor: round2(e.score_receptor),
      rol_provisional,
    };
  });
}

export function pickProveedorCif(text, cifs, entidades) {
  if (!cifs.length) return '';
  if (cifs.length === 1) return cifs[0];

  if (entidades && entidades.length > 0) {
    const byCif = new Map(entidades.map((e) => [normalizeCif(e.cif) || e.cif, e]));
    const scored = cifs.map((cif) => {
      const ec = byCif.get(normalizeCif(cif) || cif);
      const net = ec ? netEmisorScore(ec) : 0;
      return { cif, net };
    });
    scored.sort((a, b) => b.net - a.net);
    return scored[0].cif;
  }

  const RECEPTOR_LABELS = RECEPTOR_LABELS_CTX;
  const EMISOR_LABELS = EMISOR_LABELS_CTX;
  const lower = text.toLowerCase();
  const CONTEXT_RADIUS = CONTEXT_RADIUS_CIF;

  const scores = cifs.map((cif) => {
    const cifRegex = new RegExp(cif.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let pos = -1;
    const match = cifRegex.exec(text);
    if (match) pos = match.index;

    let score = 0;

    if (pos >= 0) {
      const ctxStart = Math.max(0, pos - CONTEXT_RADIUS);
      const ctxEnd = Math.min(text.length, pos + cif.length + CONTEXT_RADIUS);
      const context = text.slice(ctxStart, ctxEnd);

      if (RECEPTOR_LABELS.test(context)) score -= 10;
      if (EMISOR_LABELS.test(context)) score += 10;

      const beforeCif = lower.slice(Math.max(0, pos - 60), pos);
      if (/\b(nif|cif|vat)\s*[:.]?\s*$/i.test(beforeCif)) score += 2;

      score -= pos / text.length * 2;
    }

    return { cif, score, pos };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores[0].cif;
}

/**
 * No elegir como proveedor un CIF cuya entidad queda claramente como receptor (p. ej. bloque «Datos del cliente»).
 */
export function pickProveedorCifExcluyendoReceptorFuerte(text, cifs, entidades) {
  if (!cifs.length) return '';
  const filtered = cifs.filter((cif) => {
    const e = entidades?.find((x) => normalizeCif(x.cif) === normalizeCif(cif));
    if (!e) return true;
    const net = netEmisorScore(e);
    return net > -2.5;
  });
  const usable = filtered.length ? filtered : cifs;
  return pickProveedorCif(text, usable, entidades);
}

export function ambiguedadProveedorDesdeEntidades(entidades) {
  if (!entidades || entidades.length < 2) return false;
  const sorted = [...entidades].sort((a, b) => netEmisorScore(b) - netEmisorScore(a));
  const n0 = netEmisorScore(sorted[0]);
  const n1 = netEmisorScore(sorted[1]);
  return Math.abs(n0 - n1) < 1.5;
}

/**
 * total_factura = base_imponible + total_iva - retencion (coherencia con redondeo 2 decimales).
 */
export function parseTextoFacturaCompleto(text) {
  const parseImporte = (str) => normalizeImporteFacturaEsp(str);
  let m;

  const entidades_candidatas = extraerEntidadesCandidatas(text);

  const cifs = [];
  const cifRegex = /\b([A-Z]\d{7}[A-Z0-9]|\d{8}[A-Z])\b/gi;
  while ((m = cifRegex.exec(text)) !== null) {
    if (!cifs.includes(m[1].toUpperCase())) cifs.push(m[1].toUpperCase());
  }
  const proveedor_cif = pickProveedorCifExcluyendoReceptorFuerte(text, cifs, entidades_candidatas);
  const ambiguedad_proveedor = ambiguedadProveedorDesdeEntidades(entidades_candidatas);

  const fechas = [];
  const fechaRegex = /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/g;
  while ((m = fechaRegex.exec(text)) !== null) {
    let y = m[3].length === 2 ? '20' + m[3] : m[3];
    const yNum = parseInt(y, 10);
    if (yNum < 2000 || yNum > 2100) continue;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      fechas.push(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }

  let totalFactura = 0;
  let baseImponible = 0;
  let totalIva = 0;
  let retencion = 0;

  const amountCapture = '(\\d{1,3}(?:[.,]\\d{3})*[.,]\\d{2})';

  const totalSpecificRegex = new RegExp(
    `(?:total\\s+factura|importe\\s+total|total\\s+a\\s+pagar)[:\\s]*${amountCapture}\\s*€?`,
    'gi',
  );
  const totalGenericRegex = new RegExp(`(?:total)[:\\s]*${amountCapture}\\s*€?`, 'gi');
  const baseRegex = new RegExp(
    `(?:base\\s*imponible|subtotal|base\\s+i)[:\\s]*${amountCapture}\\s*€?`,
    'gi',
  );
  const ivaRegex = new RegExp(
    `(?:cuota\\s*iva|iva\\s*(?:\\d+\\s*%?\\s*)?|total\\s*iva|importe\\s*iva)[:\\s]*${amountCapture}\\s*€?`,
    'gi',
  );
  const retencionRegex = new RegExp(
    `(?:retenci[oó]n|irpf|cuota\\s*retenci[oó]n|importe\\s*retenci[oó]n|ret\\.?\\s*profesional)[:\\s]*${amountCapture}\\s*€?`,
    'gi',
  );

  const baseMatches = [];
  while ((m = baseRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) baseMatches.push(v);
  }
  if (baseMatches.length > 0) baseImponible = baseMatches[baseMatches.length - 1];

  const ivaMatches = [];
  while ((m = ivaRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) ivaMatches.push(v);
  }
  if (ivaMatches.length > 0) totalIva = ivaMatches[ivaMatches.length - 1];

  const retencionMatches = [];
  while ((m = retencionRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v >= 0) retencionMatches.push(v);
  }
  if (retencionMatches.length > 0) retencion = retencionMatches[retencionMatches.length - 1];

  const totalSpecificMatches = [];
  while ((m = totalSpecificRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) totalSpecificMatches.push(v);
  }

  const totalGenericMatches = [];
  while ((m = totalGenericRegex.exec(text)) !== null) {
    const v = parseImporte(m[1]);
    if (!Number.isNaN(v) && v > 0) totalGenericMatches.push(v);
  }

  if (totalSpecificMatches.length > 0) {
    totalFactura = totalSpecificMatches[totalSpecificMatches.length - 1];
  } else {
    const candidates = totalGenericMatches.filter((v) => !baseImponible || v !== baseImponible);
    if (candidates.length > 0) {
      totalFactura = candidates[candidates.length - 1];
    } else if (totalGenericMatches.length > 0) {
      totalFactura = totalGenericMatches[totalGenericMatches.length - 1];
    }
  }

  const totalMatches = [...totalSpecificMatches, ...totalGenericMatches];

  if (!totalFactura || !baseImponible) {
    const allImportes = [];
    const importePatterns = [
      /(\d{1,3}(?:\.\d{3})*,\d{2})\s*€/g,
      /€\s*(\d{1,3}(?:\.\d{3})*,\d{2})/g,
      /(\d{1,3}(?:\.\d{3})*,\d{2})/g,
      /(\d+\.\d{2})\s*€/g,
      /€\s*(\d+\.\d{2})/g,
      /\b(\d{1,3}(?:\.\d{3})+\.\d{2})\b/g,
    ];
    for (const regex of importePatterns) {
      while ((m = regex.exec(text)) !== null) {
        const val = parseImporte(m[1]);
        if (!Number.isNaN(val) && val > 0.01) allImportes.push(val);
      }
    }
    const unique = [...new Set(allImportes)].sort((a, b) => b - a);
    if (!totalFactura && unique.length > 0) totalFactura = unique[0];
    if (!baseImponible && unique.length > 1) baseImponible = unique[1];
    if (!totalIva && unique.length > 2) totalIva = unique[2];
  }

  if (baseImponible && totalFactura && !totalIva && retencionMatches.length === 0) {
    const diff = totalFactura - baseImponible;
    if (diff > 0 && diff < baseImponible * 0.5) totalIva = round2(diff);
  }
  if (totalFactura && totalIva && !baseImponible) {
    baseImponible = Math.round((totalFactura - totalIva + retencion) * 100) / 100;
  }

  const { lineas: desglose_impuestos, meta: desglose_parse_meta } = parseDesgloseFiscalFromText(
    text,
    parseImporte,
  );
  const usarAgregadosDesglose = debeUsarAgregadosDesglose(desglose_impuestos);
  let recargo_equivalencia_total = 0;
  let base_imponible_total = round2(baseImponible);

  if (usarAgregadosDesglose && desglose_impuestos.length > 0) {
    const agg = agregarResumenDesdeDesglose(desglose_impuestos);
    baseImponible = agg.base_imponible_total;
    base_imponible_total = agg.base_imponible_total;
    totalIva = agg.iva_total;
    retencion = agg.retencion_total;
    recargo_equivalencia_total = agg.recargo_equivalencia_total;
  }

  const esperadoSimple = round2(baseImponible + totalIva - retencion);
  let importes_coherentes;
  if (usarAgregadosDesglose && desglose_impuestos.length > 0) {
    const vd = validarCoherenciaDesglose(desglose_impuestos, totalFactura);
    importes_coherentes = vd.importes_coherentes;
  } else {
    importes_coherentes =
      totalFactura > 0 && baseImponible > 0 && Math.abs(totalFactura - esperadoSimple) <= 0.05;
  }

  if (baseImponible > 0 && totalIva >= 0 && !totalFactura) {
    totalFactura = usarAgregadosDesglose && desglose_impuestos.length > 0
      ? totalEsperadoDesdeDesglose(desglose_impuestos)
      : esperadoSimple;
    importes_coherentes = true;
  }
  /* Retención solo explícita (regex / desglose); no inferir por diferencia matemática. */
  if (
    !usarAgregadosDesglose &&
    baseImponible > 0 &&
    totalIva >= 0 &&
    retencion >= 0 &&
    !importes_coherentes
  ) {
    totalFactura = round2(baseImponible + totalIva - retencion);
    importes_coherentes = true;
  }

  const numFacturas = [];
  const nfPatterns = [
    /(?:factura|fact\.?|fra\.?|invoice|nº\s*fact(?:ura)?|n[uú]m(?:ero)?\.?\s*(?:de\s+)?fact(?:ura)?)[:\s#nº.]*\s*([A-Z0-9][A-Z0-9\-\/. ]*[A-Z0-9])/gi,
    /(?:nº|n\.º|núm\.?|número)[:\s]+([A-Z0-9][A-Z0-9\-\/]*)/gi,
    /(?:invoice\s*(?:no|number|#)?)[:\s]*([A-Z0-9][A-Z0-9\-\/]*)/gi,
  ];
  for (const regex of nfPatterns) {
    while ((m = regex.exec(text)) !== null) {
      const val = m[1].trim();
      if (val.length >= 1 && !numFacturas.includes(val)) numFacturas.push(val);
    }
  }

  return {
    cifs,
    entidades_candidatas,
    proveedor_cif,
    ambiguedad_proveedor,
    fechas,
    totalFactura: round2(totalFactura),
    baseImponible: round2(baseImponible),
    base_imponible_total: round2(base_imponible_total),
    totalIva: round2(totalIva),
    retencion: round2(retencion),
    recargo_equivalencia_total: round2(recargo_equivalencia_total),
    desglose_impuestos,
    desglose_parse_meta,
    usar_desglose_multi: usarValidacionDesgloseMultiple(desglose_impuestos),
    totalMatches,
    baseMatches,
    ivaMatches,
    retencionMatches,
    numFacturas,
    importes_coherentes,
  };
}

export function importesCoherentes(base, iva, ret, total) {
  if (!total || total <= 0) return false;
  const exp = round2(base + iva - ret);
  return Math.abs(exp - total) <= 0.05;
}

function needsReparseImportes(snap) {
  const base = Number(snap.base_imponible) || 0;
  const iva = Number(snap.total_iva) || 0;
  const ret = Number(snap.retencion) || 0;
  const total = Number(snap.total_factura) || 0;
  const missing = !total || total <= 0 || !base;
  if (missing) return true;
  return !importesCoherentes(base, iva, ret, total);
}

/**
 * Encuentra receptor: prioridad CIF exacto → dígitos (un solo candidato) → nombre conservador + contexto.
 */
export function encontrarEntidadReceptora(sociedadCif, sociedadNombre, entidades) {
  const socNorm = normalizeCif(sociedadCif || '');
  const nombreSocNorm = normalizeNombreComparacion(sociedadNombre || '');

  // 1) CIF exacto
  for (let i = 0; i < entidades.length; i++) {
    const e = entidades[i];
    const ecif = normalizeCif(e.cif || '');
    if (socNorm && ecif && ecif === socNorm) {
      return { index: i, entity: e, receptor_resuelto_por: 'cif', match_por: 'cif' };
    }
  }

  // 2) Dígitos fiscales (único candidato)
  if (socNorm && cifDigitsOnly(socNorm).length >= 7) {
    const d = cifDigitsOnly(socNorm);
    const matches = entidades
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => cifDigitsOnly(normalizeCif(e.cif || '')) === d);
    if (matches.length === 1) {
      return {
        index: matches[0].i,
        entity: matches[0].e,
        receptor_resuelto_por: 'digitos',
        match_por: 'digitos',
      };
    }
  }

  // 3) Nombre: umbral alto + soporte de contexto/dirección
  if (nombreSocNorm.length >= 8) {
    let best = null;
    for (let i = 0; i < entidades.length; i++) {
      const e = entidades[i];
      const en = normalizeNombreComparacion(e.nombre_candidato || '');
      if (!nombreSimilaridadFuerte(nombreSocNorm, en)) continue;
      const ctx = String(e.contexto || '');
      const soporteContexto =
        RECEPTOR_LABELS_CTX.test(ctx) ||
        e.rol_provisional === 'receptor' ||
        (e.score_receptor ?? 0) > (e.score_emisor ?? 0) - 0.5 ||
        (String(e.direccion_candidata || '').length > 12);
      if (!soporteContexto) continue;
      const score = (e.score_receptor ?? 0) - (e.score_emisor ?? 0);
      if (!best || score > best.score) best = { i, e, score };
    }
    if (best) {
      return {
        index: best.i,
        entity: best.e,
        receptor_resuelto_por: 'nombre_contexto',
        match_por: 'nombre',
      };
    }
  }

  return { index: -1, entity: null, receptor_resuelto_por: null, match_por: null };
}

/**
 * Reconciliación: excluye receptor; elige mejor emisor; respeta campos_manuales.
 */
export async function reconciliarFacturaOcr(body, deps) {
  const {
    buscarEmpresaPorCif,
    getNombreFromEmpresaItem,
    getIdEmpresaFromItem,
} = deps;

  const {
    sociedad_cif,
    sociedad_nombre,
    entidades_candidatas = [],
    texto_extraido = '',
    extraction_snapshot = {},
    campos_manuales = {},
    proveedor_provisional_cif = '',
  } = body || {};

  const snap = { ...extraction_snapshot };
  const socNorm = normalizeCif(sociedad_cif || '');

  const receptorMatch = encontrarEntidadReceptora(sociedad_cif, sociedad_nombre, entidades_candidatas);
  const receptorCifNorm = receptorMatch.entity ? normalizeCif(receptorMatch.entity.cif) : socNorm;

  const candidatosProveedor = entidades_candidatas.filter((e) => {
    const ec = normalizeCif(e.cif || '');
    if (!ec) return false;
    if (receptorCifNorm && ec === receptorCifNorm) return false;
    if (!receptorMatch.entity && socNorm && ec === socNorm) return false;
    return true;
  });

  const sorted = [...candidatosProveedor].sort((a, b) => netEmisorScore(b) - netEmisorScore(a));
  let ambiguedadProveedor = false;
  if (sorted.length >= 2) {
    const n0 = netEmisorScore(sorted[0]);
    const n1 = netEmisorScore(sorted[1]);
    if (Math.abs(n0 - n1) < 1.5) ambiguedadProveedor = true;
  }

  const provNorm = normalizeCif(proveedor_provisional_cif || '');
  /** El proveedor OCR coincidía con la sociedad receptora (había que intercambiar rol). */
  const provEraReceptor = !!(socNorm && provNorm && socNorm === provNorm);
  const baseSnap = Number(snap.base_imponible) || 0;
  const ivaSnap = Number(snap.total_iva) || 0;
  const retSnap = Number(snap.retencion) || 0;
  const totalSnap = Number(snap.total_factura) || 0;
  const snapCoherent = importesCoherentes(baseSnap, ivaSnap, retSnap, totalSnap);

  const reparseImportes =
    texto_extraido &&
    texto_extraido.length > 20 &&
    !ambiguedadProveedor &&
    (needsReparseImportes(snap) || (provEraReceptor && !snapCoherent));

  let parseoImportes = null;
  if (reparseImportes) {
    parseoImportes = parseTextoFacturaCompleto(texto_extraido);
  }

  const candidatos_resumen = sorted.slice(0, 3).map((e) => ({
    cif: e.cif,
    net_emisor: round2(netEmisorScore(e)),
    rol_provisional: e.rol_provisional,
  }));

  let warning = '';
  if (ambiguedadProveedor) {
    warning =
      'No se pudo determinar con claridad el proveedor entre varios CIFs. Revisa y edita el CIF de proveedor si es necesario.';
  }
  if (!receptorMatch.entity && socNorm && entidades_candidatas.length > 0) {
    warning = (warning ? `${warning} ` : '') + 'La sociedad seleccionada no coincide con ninguna entidad detectada por CIF en el documento.';
  }

  const out = {
    proveedor_cif: snap.proveedor_cif || '',
    proveedor_nombre: '',
    empresa_id: '',
    proveedor_en_maestros: false,
    nombre_sugerido_ocr: '',
    numero_factura_proveedor: snap.numero_factura_proveedor || '',
    fecha_emision: snap.fecha_emision || '',
    base_imponible: round2(Number(snap.base_imponible) || 0),
    base_imponible_total: round2(Number(snap.base_imponible_total ?? snap.base_imponible) || 0),
    total_iva: round2(Number(snap.total_iva) || 0),
    retencion: round2(Number(snap.retencion) || 0),
    recargo_equivalencia_total: round2(Number(snap.recargo_equivalencia_total) || 0),
    desglose_impuestos: Array.isArray(snap.desglose_impuestos) ? snap.desglose_impuestos : [],
    total_factura: round2(Number(snap.total_factura) || 0),
    confianza: snap.confianza && typeof snap.confianza === 'object' ? { ...snap.confianza } : {},
    proveedor_resuelto_por: 'extraccion',
    receptor_resuelto_por: receptorMatch.receptor_resuelto_por,
    match_por: receptorMatch.match_por,
    ambiguedad_proveedor: ambiguedadProveedor,
    warning: warning || null,
    candidatos_resumen,
    importes_recalculados: false,
  };

  if (parseoImportes && !ambiguedadProveedor) {
    if (!campos_manuales.base_imponible) out.base_imponible = parseoImportes.baseImponible;
    if (!campos_manuales.total_iva) out.total_iva = parseoImportes.totalIva;
    if (!campos_manuales.retencion) out.retencion = parseoImportes.retencion;
    if (!campos_manuales.total_factura) out.total_factura = parseoImportes.totalFactura;
    if (!campos_manuales.base_imponible) {
      out.base_imponible_total = parseoImportes.base_imponible_total ?? parseoImportes.baseImponible;
    }
    out.recargo_equivalencia_total = parseoImportes.recargo_equivalencia_total ?? 0;
    out.desglose_impuestos = Array.isArray(parseoImportes.desglose_impuestos)
      ? parseoImportes.desglose_impuestos
      : [];
    out.importes_recalculados = true;
  }

  if (ambiguedadProveedor) {
    out.proveedor_resuelto_por = 'ambiguo_sin_cambio';
    return out;
  }

  const best = sorted[0];
  if (!best) {
    out.proveedor_resuelto_por = 'sin_candidato';
    out.warning =
      (out.warning ? `${out.warning} ` : '') +
      'No quedó ningún CIF candidato a proveedor tras excluir la sociedad receptora.';
    return out;
  }

  const bestCif = normalizeCif(best.cif) || best.cif;
  if (!campos_manuales.proveedor_cif) {
    out.proveedor_cif = bestCif;
  }
  out.proveedor_resuelto_por =
    provEraReceptor && bestCif && provNorm && bestCif !== provNorm
      ? 'reconciliacion_intercambio_rol'
      : 'reconciliacion_exclusion';

  const cifParaMaestro = campos_manuales.proveedor_cif ? String(snap.proveedor_cif || '').trim() : bestCif;
  if (cifParaMaestro) {
    try {
      const emp = await buscarEmpresaPorCif(cifParaMaestro);
      if (emp) {
        if (!campos_manuales.proveedor_nombre) {
          out.proveedor_nombre = getNombreFromEmpresaItem(emp);
        }
        out.empresa_id = getIdEmpresaFromItem(emp);
        out.proveedor_en_maestros = true;
        out.nombre_sugerido_ocr = '';
      } else if (!campos_manuales.proveedor_nombre) {
        out.proveedor_nombre = best.nombre_candidato || '';
        out.nombre_sugerido_ocr = best.nombre_candidato || '';
        out.proveedor_en_maestros = false;
        out.empresa_id = '';
      }
    } catch {
      /* */
    }
  }

  const reTot = round2(Number(out.recargo_equivalencia_total) || 0);
  const tf = round2(out.base_imponible + out.total_iva + reTot - out.retencion);
  if (!campos_manuales.total_factura && Math.abs(tf - out.total_factura) > 0.05) {
    out.total_factura = tf;
  }

  return out;
}
