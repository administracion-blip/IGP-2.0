/**
 * Desglose fiscal múltiple:
 *   Fase A: regex globales.  Fase B: líneas/tablas + triple con permutación.
 *   Fase C: ventanas multilínea.  Fase D: tabla resumen fiscal (cabecera «BASE IMP» + filas).
 * R.E. no es retención IRPF. (Sin importar ocrFacturaValidacion: evita ciclo.)
 */
const TOLERANCIA_IMPORTES = 0.02;

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function normalizeImporteLocal(raw) {
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
    if (parts.length === 2 && parts[1].length <= 2) return parseFloat(s);
    if (parts.length > 2) {
      const sign = s.startsWith('-') ? -1 : 1;
      const n = parseFloat(s.replace(/^-/, '').split('.').join(''));
      return Number.isFinite(n) ? sign * n : NaN;
    }
    if (parts.length === 2 && parts[1].length === 3) return parseFloat(s.replace('.', ''));
    return parseFloat(s);
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

const RE_MARKERS =
  /\b(?:%R\.E\.|R\.E\.|Recargo\s+de\s+Equivalencia|Imp\.?\s*R\.E\.|cuota\s+R\.E\.|R\.E\.?\s*%)\b/i;

const AMT_CORE =
  '\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d{1,3}(?:\\.\\d{3})+\\.\\d{2}|\\d+[,.]\\d{2}';

function parsePct(s) {
  if (s == null || s === '') return null;
  const n = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(n) ? round2(n) : null;
}

function lineaKey(L) {
  return `${L.tipo}|${round2(L.base)}|${L.porcentaje ?? 'x'}|${round2(L.cuota)}`;
}

export function dedupeLineasDesglose(lineas) {
  const seen = new Set();
  const out = [];
  for (const L of lineas) {
    const k = lineaKey(L);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(L);
  }
  return out;
}

export function agregarResumenDesdeDesglose(lineas) {
  let base_imponible_total = 0;
  let iva_total = 0;
  let recargo_equivalencia_total = 0;
  let retencion_total = 0;
  for (const L of lineas) {
    const b = round2(Number(L.base) || 0);
    const c = round2(Number(L.cuota) || 0);
    if (L.tipo === 'iva') {
      base_imponible_total = round2(base_imponible_total + b);
      iva_total = round2(iva_total + c);
    } else if (L.tipo === 'recargo_equivalencia') {
      base_imponible_total = round2(base_imponible_total + b);
      recargo_equivalencia_total = round2(recargo_equivalencia_total + c);
    } else if (L.tipo === 'retencion') {
      retencion_total = round2(retencion_total + c);
    }
  }
  return {
    base_imponible_total,
    iva_total,
    recargo_equivalencia_total,
    retencion_total,
  };
}

export function totalEsperadoDesdeDesglose(lineas) {
  const r = agregarResumenDesdeDesglose(lineas);
  return round2(
    r.base_imponible_total + r.iva_total + r.recargo_equivalencia_total - r.retencion_total,
  );
}

export { TOLERANCIA_IMPORTES };

export function validarCoherenciaDesglose(lineas, totalFactura, tol = TOLERANCIA_IMPORTES) {
  const t = Number(totalFactura) || 0;
  const esperado = totalEsperadoDesdeDesglose(lineas);
  const diferencia = round2(t - esperado);
  const ok = t > 0 && Math.abs(diferencia) <= tol;
  return {
    ok,
    importes_coherentes: ok,
    diferencia_importes: diferencia,
    total_esperado: esperado,
    formula_usada:
      'suma(bases) + suma(cuotas IVA) + suma(cuotas R.E.) − suma(cuotas retención) ≈ total_factura',
    total_calculado_desde_desglose: esperado,
  };
}

export function usarValidacionDesgloseMultiple(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) return false;
  if (lineas.length > 1) return true;
  if (lineas.some((l) => l.tipo === 'recargo_equivalencia')) return true;
  if (lineas.filter((l) => l.tipo === 'iva').length > 1) return true;
  if (lineas.filter((l) => l.tipo === 'retencion').length > 1) return true;
  return false;
}

export function debeUsarAgregadosDesglose(lineas) {
  if (!Array.isArray(lineas) || lineas.length === 0) return false;
  if (usarValidacionDesgloseMultiple(lineas)) return true;
  if (lineas.some((l) => l.tipo === 'recargo_equivalencia')) return true;
  if (lineas.filter((l) => l.tipo === 'iva').length >= 2) return true;
  return false;
}

function cuotaCoherenteConBasePct(base, pct, cuota) {
  if (base <= 0 || pct == null || cuota < 0) return false;
  if (pct < 0.05 || pct > 35) return false;
  const esperado = round2((base * pct) / 100);
  const tol = Math.max(0.06, Math.abs(base) * 0.015, Math.abs(esperado) * 0.02);
  return Math.abs(esperado - cuota) <= tol;
}

const RE_LEGAL_PCTS = [5.2, 1.4, 0.5];

function esTipoRELegal(pct) {
  if (pct == null) return false;
  return RE_LEGAL_PCTS.some((r) => Math.abs(round2(pct) - r) < 0.05);
}

function extraerImportesEnOrden(line, parseImporteFn) {
  const re = new RegExp(`(${AMT_CORE})`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(line)) !== null) {
    const v = parseImporteFn(m[1]);
    if (!Number.isNaN(v) && v > 0.009) out.push(round2(v));
  }
  return out;
}

function extraerPorcentajesLinea(line) {
  const out = [];
  const re = /(\d{1,2}[,.]\d{1,2}|\d{1,2})\s*%/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const p = parsePct(m[1]);
    if (p != null && p >= 0.05 && p <= 35) out.push(p);
  }
  return [...new Set(out.map((x) => round2(x)))];
}

function parsePhaseBLineas(rawLines, parseImporteFn, debug) {
  const candidatos = [];
  const lineas = rawLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  for (let idx = 0; idx < lineas.length; idx++) {
    const line = lineas[idx];
    if (RE_MARKERS.test(line) && /retenci|irpf/i.test(line)) continue;

    if (/\|/.test(line) || /\t/.test(line)) {
      const cells = line.split(/\|/).map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 3) {
        const nums = cells
          .map((c) => parseImporteFn(c.replace(/[^\d.,\-]/g, '')))
          .filter((n) => !Number.isNaN(n) && n > 0);
        const pcts = cells.flatMap((c) => extraerPorcentajesLinea(c));
        if (nums.length >= 2 && pcts.length >= 1) {
          const base = nums[0];
          const pct = pcts[0];
          const cuota = nums.find((n, i) => i > 0 && cuotaCoherenteConBasePct(base, pct, n));
          if (cuota != null && cuotaCoherenteConBasePct(base, pct, cuota)) {
            const tipo = RE_MARKERS.test(line) ? 'recargo_equivalencia' : 'iva';
            candidatos.push({
              tipo,
              base,
              porcentaje: pct,
              cuota,
              origen: 'faseB_tabla_fila',
              texto_origen: line.slice(0, 140),
              _lineIndex: idx,
            });
            debug.bloques_candidatos.push({ tipo: 'tabla_fila', linea: idx, preview: line.slice(0, 100) });
          }
        }
      }
    }

    const labeled = new RegExp(
      `(?:base|b\\.?|base\\s*imponible)\\s*[:\\s]?\s*(${AMT_CORE}).*?(?:iva|tipo)\\s*[:\\s]?\s*([\\d]+[,.]?\\d*)\\s*%.*?(?:cuota|importe(?:\\s*iva)?)\\s*[:\\s]?\s*(${AMT_CORE})`,
      'i',
    );
    let lm = labeled.exec(line);
    if (lm) {
      const base = parseImporteFn(lm[1]);
      const pct = parsePct(lm[2]);
      const cuota = parseImporteFn(lm[3]);
      if (!Number.isNaN(base) && base > 0 && pct != null && !Number.isNaN(cuota) && cuota >= 0) {
        candidatos.push({
          tipo: RE_MARKERS.test(line) ? 'recargo_equivalencia' : 'iva',
          base,
          porcentaje: pct,
          cuota,
          origen: 'faseB_etiquetado',
          texto_origen: line.slice(0, 140),
          _lineIndex: idx,
        });
        debug.bloques_candidatos.push({ tipo: 'etiquetado', linea: idx });
      }
      continue;
    }

    const tripleLoose = new RegExp(
      `(${AMT_CORE})\\s+(\\d{1,2}[,.]\\d{0,3}|\\d{1,2})\\s+(${AMT_CORE})`,
    );
    lm = tripleLoose.exec(line);
    if (lm && !RE_MARKERS.test(line)) {
      const v1 = parseImporteFn(lm[1]);
      const pct = parsePct(lm[2]);
      const v3 = parseImporteFn(lm[3]);
      if (!Number.isNaN(v1) && !Number.isNaN(v3) && pct != null && pct >= 0.5 && pct <= 30) {
        if (v1 > 50 && cuotaCoherenteConBasePct(v1, pct, v3)) {
          candidatos.push({
            tipo: 'iva',
            base: v1,
            porcentaje: pct,
            cuota: v3,
            origen: 'faseB_triple_sin_al',
            texto_origen: line.slice(0, 140),
            _lineIndex: idx,
          });
          debug.bloques_candidatos.push({ tipo: 'triple_misma_linea', linea: idx });
        } else if (v3 > 50 && cuotaCoherenteConBasePct(v3, pct, v1)) {
          candidatos.push({
            tipo: 'iva',
            base: v3,
            porcentaje: pct,
            cuota: v1,
            origen: 'faseB_triple_invertido',
            texto_origen: line.slice(0, 140),
            _lineIndex: idx,
          });
          debug.bloques_candidatos.push({ tipo: 'triple_invertido', linea: idx });
        }
      }
    }
  }

  return candidatos;
}

function parsePhaseCVentanas(rawLines, parseImporteFn, debug) {
  const lineas = rawLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];

  for (let i = 0; i <= lineas.length - 3; i++) {
    const a = lineas[i];
    const b = lineas[i + 1];
    const c = lineas[i + 2];
    if (RE_MARKERS.test(`${a} ${b} ${c}`) && /retenci/i.test(`${a} ${b}`)) continue;

    const amtsA = extraerImportesEnOrden(a, parseImporteFn);
    const amtsC = extraerImportesEnOrden(c, parseImporteFn);
    const pctsB = extraerPorcentajesLinea(b);
    if (amtsA.length >= 1 && amtsC.length >= 1 && pctsB.length >= 1) {
      const base = amtsA[0];
      const pct = pctsB[0];
      const cuota = amtsC[0];
      if (
        base > 30 &&
        cuotaCoherenteConBasePct(base, pct, cuota) &&
        !RE_MARKERS.test(`${a}${b}${c}`)
      ) {
        out.push({
          tipo: 'iva',
          base,
          porcentaje: pct,
          cuota,
          origen: 'faseC_ventana_3lineas',
          texto_origen: `${a.slice(0, 40)} | ${b.slice(0, 40)} | ${c.slice(0, 40)}`,
          _lineIndex: i,
        });
        debug.bloques_candidatos.push({ tipo: 'ventana_3', desde_linea: i });
      }
    }
  }

  for (let i = 0; i <= lineas.length - 2; i++) {
    const a = lineas[i];
    const b = lineas[i + 1];
    const amtsA = extraerImportesEnOrden(a, parseImporteFn);
    const pctsA = extraerPorcentajesLinea(a);
    const amtsB = extraerImportesEnOrden(b, parseImporteFn);
    const pctsB = extraerPorcentajesLinea(b);
    if (amtsA.length >= 1 && amtsB.length >= 1) {
      const base = amtsA[0];
      const cuota = amtsB[amtsB.length - 1];
      const pct = pctsA[0] || pctsB[0];
      if (pct != null && cuotaCoherenteConBasePct(base, pct, cuota) && !RE_MARKERS.test(a + b)) {
        out.push({
          tipo: 'iva',
          base,
          porcentaje: pct,
          cuota,
          origen: 'faseC_dos_lineas',
          texto_origen: `${a.slice(0, 60)} / ${b.slice(0, 60)}`,
          _lineIndex: i,
        });
        debug.bloques_candidatos.push({ tipo: 'ventana_2', desde_linea: i });
      }
    }
  }

  return out;
}

function extraerPctCandidatosFila(line) {
  const pcts = [];
  const explicit = extraerPorcentajesLinea(line);
  pcts.push(...explicit);

  const amtRe = new RegExp(`^(?:${AMT_CORE})$`);
  const tokens = line.split(/[\s\t]+/).filter(Boolean);
  for (const tok of tokens) {
    const cleaned = tok.replace(/%$/, '').trim();
    if (!cleaned || amtRe.test(cleaned)) continue;
    const p = parsePct(cleaned);
    if (p != null && p >= 1 && p <= 30 && !pcts.includes(round2(p))) {
      pcts.push(round2(p));
    }
  }
  return [...new Set(pcts)];
}

function parsePhaseDTablaResumen(rawLines, parseImporteFn, debug) {
  const out = [];
  const lineas = rawLines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  for (let h = 0; h < lineas.length; h++) {
    const hdr = lineas[h];
    if (!/\bBASE\s+IMP/i.test(hdr)) continue;
    if (!/I\.?V\.?A/i.test(hdr)) continue;

    debug.bloques_candidatos.push({
      tipo: 'tabla_resumen_header',
      linea: h,
      preview: hdr.slice(0, 100),
    });

    for (let j = h + 1; j < Math.min(h + 16, lineas.length); j++) {
      const dataLine = lineas[j];

      if (/^\s*(?:inscrita|registro\s+mercantil|[a-z0-9._%+-]+@[a-z])/i.test(dataLine)) break;
      if (!/\d/.test(dataLine)) continue;

      const amts = extraerImportesEnOrden(dataLine, parseImporteFn);
      if (amts.length < 2) continue;

      const pcts = extraerPctCandidatosFila(dataLine);
      if (pcts.length === 0) continue;

      for (const pct of pcts) {
        let found = false;
        for (let a = 0; a < amts.length && !found; a++) {
          for (let b = 0; b < amts.length && !found; b++) {
            if (a === b) continue;
            if (!cuotaCoherenteConBasePct(amts[a], pct, amts[b])) continue;
            const nearRE = RE_MARKERS.test(dataLine) || RE_MARKERS.test(lineas[j - 1] || '');
            const tipo = nearRE && esTipoRELegal(pct) ? 'recargo_equivalencia' : 'iva';
            out.push({
              tipo,
              base: amts[a],
              porcentaje: pct,
              cuota: amts[b],
              origen: 'faseD_tabla_resumen',
              texto_origen: dataLine.slice(0, 140),
              _lineIndex: j,
            });
            debug.bloques_candidatos.push({
              tipo: 'tabla_resumen_fila',
              linea: j,
              preview: dataLine.slice(0, 100),
            });
            found = true;
          }
        }
      }
    }
    break;
  }
  return out;
}

function parsePhaseARegex(raw, parseImporteFn, push) {
  const amt = `(${AMT_CORE})`;

  const reBlock = new RegExp(
    `${amt}\\s*[\\s\\S]{0,280}?(?:%\\s*R\\.E\\.|R\\.E\\.|R\\.E\\s*%|Imp\\.?\\s*R\\.E\\.|Recargo\\s+de\\s+Equivalencia)\\s*([\\d]+[,.]?\\d*)\\s*%?\\s*[\\s\\S]{0,180}?${amt}`,
    'gi',
  );
  let m;
  while ((m = reBlock.exec(raw)) !== null) {
    const base = parseImporteFn(m[1]);
    const pct = parsePct(m[2]);
    const cuota = parseImporteFn(m[3]);
    if (Number.isNaN(base) || base <= 0 || Number.isNaN(cuota) || cuota < 0) continue;
    push({
      tipo: 'recargo_equivalencia',
      base,
      porcentaje: pct,
      cuota,
      origen: 'faseA_regex_re',
      texto_origen: m[0].slice(0, 120),
    });
  }

  const ivaLine = new RegExp(
    `${amt}\\s*al\\s*([\\d]+[,.]?\\d*)\\s*%?\\s*(?:IVA|con\\s+IVA)?\\s*${amt}`,
    'gi',
  );
  while ((m = ivaLine.exec(raw)) !== null) {
    const fragment = m[0];
    if (RE_MARKERS.test(fragment)) continue;
    const base = parseImporteFn(m[1]);
    const pct = parsePct(m[2]);
    const cuota = parseImporteFn(m[3]);
    if (Number.isNaN(base) || base <= 0 || Number.isNaN(cuota) || cuota < 0) continue;
    push({
      tipo: 'iva',
      base,
      porcentaje: pct,
      cuota,
      origen: 'faseA_regex_iva_al',
      texto_origen: fragment.slice(0, 120),
    });
  }

  const ivaTipo = new RegExp(
    `${amt}\\s+[^\\n]{0,120}?\\b(?:IVA|tipo)\\s*([\\d]+[,.]?\\d*)\\s*%\\s*[^\\d]{0,50}?${amt}`,
    'gi',
  );
  while ((m = ivaTipo.exec(raw)) !== null) {
    if (RE_MARKERS.test(m[0])) continue;
    const base = parseImporteFn(m[1]);
    const pct = parsePct(m[2]);
    const cuota = parseImporteFn(m[3]);
    if (Number.isNaN(base) || base <= 0 || Number.isNaN(cuota) || cuota < 0) continue;
    push({
      tipo: 'iva',
      base,
      porcentaje: pct,
      cuota,
      origen: 'faseA_regex_iva_tipo',
      texto_origen: m[0].slice(0, 120),
    });
  }

  const retLine = new RegExp(
    `(?:retenci[oó]n|irpf|cuota\\s*retenci[oó]n|importe\\s*retenci[oó]n|ret\\.?\\s*profesional)\\s*:?\\s*${amt}`,
    'gi',
  );
  while ((m = retLine.exec(raw)) !== null) {
    const ctx = raw.slice(Math.max(0, m.index - 30), Math.min(raw.length, m.index + m[0].length + 30));
    if (RE_MARKERS.test(ctx)) continue;
    const cuota = parseImporteFn(m[1]);
    if (Number.isNaN(cuota) || cuota < 0) continue;
    push({
      tipo: 'retencion',
      base: 0,
      porcentaje: null,
      cuota,
      origen: 'faseA_regex_retencion',
      texto_origen: m[0].slice(0, 120),
    });
  }
}

function reclasificarREConPorcentajeIlegal(lineas) {
  for (const L of lineas) {
    if (L.tipo !== 'recargo_equivalencia') continue;
    if (esTipoRELegal(L.porcentaje)) continue;
    if (L.base > 0 && L.cuota > 0 && cuotaCoherenteConBasePct(L.base, L.porcentaje, L.cuota)) {
      L.tipo = 'iva';
      L.origen = (L.origen || '') + '_reclasificado_iva';
    }
  }
  return lineas;
}

/**
 * @returns {{ lineas: Array, meta: object }}
 */
export function parseDesgloseFiscalFromText(text, parseImporteFn = normalizeImporteLocal) {
  const raw = String(text || '');
  const estrategias = [
    'faseA_regex',
    'faseB_lineas_tabla',
    'faseC_ventanas',
    'faseD_tabla_resumen',
    'reclasificar_re',
  ];
  const debug = {
    lineas_detectadas_raw: [],
    bloques_candidatos: [],
  };

  const acumulado = [];
  const push = (L) => {
    if (!L || !L.tipo) return;
    const b = round2(Number(L.base) || 0);
    const c = round2(Number(L.cuota) || 0);
    if (b <= 0 && c <= 0) return;
    acumulado.push({
      ...L,
      base: b,
      porcentaje: L.porcentaje != null ? round2(Number(L.porcentaje)) : null,
      cuota: c,
    });
    debug.lineas_detectadas_raw.push(
      `${L.tipo} base=${b} pct=${L.porcentaje} cuota=${c} [${L.origen || ''}]`,
    );
  };

  const rawLines = raw.split(/\r?\n/);

  const fromD = parsePhaseDTablaResumen(rawLines, parseImporteFn, debug);
  if (fromD.length >= 1) {
    for (const row of fromD) {
      const { _lineIndex, ...rest } = row;
      push(rest);
    }
  } else {
    parsePhaseARegex(raw, parseImporteFn, push);

    const fromB = parsePhaseBLineas(rawLines, parseImporteFn, debug);
    for (const row of fromB) {
      const { _lineIndex, ...rest } = row;
      push(rest);
    }

    const fromC = parsePhaseCVentanas(rawLines, parseImporteFn, debug);
    for (const row of fromC) {
      const { _lineIndex, ...rest } = row;
      push(rest);
    }
  }

  const deduped = dedupeLineasDesglose(acumulado);
  const lineas = reclasificarREConPorcentajeIlegal(deduped);

  const meta = {
    desglose_parser_estrategias_usadas: estrategias,
    desglose_lineas_detectadas_raw: debug.lineas_detectadas_raw.slice(0, 80),
    desglose_bloques_candidatos: debug.bloques_candidatos.slice(0, 40),
    desglose_lineas_finales: lineas.length,
  };

  return { lineas, meta };
}

export function normalizarLineasDesgloseDesdeInput(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const tipo = String(x.tipo || '').toLowerCase();
    if (!['iva', 'retencion', 'recargo_equivalencia'].includes(tipo)) continue;
    const base = round2(Number(x.base) || 0);
    const cuota = round2(Number(x.cuota) || 0);
    const porcentaje =
      x.porcentaje != null && x.porcentaje !== '' ? round2(Number(x.porcentaje)) : null;
    out.push({
      tipo,
      base,
      porcentaje: Number.isFinite(porcentaje) ? porcentaje : null,
      cuota,
      subtipo: x.subtipo != null ? String(x.subtipo) : undefined,
      origen: x.origen != null ? String(x.origen) : undefined,
      confianza: x.confianza != null ? String(x.confianza) : undefined,
      texto_origen: x.texto_origen != null ? String(x.texto_origen) : undefined,
    });
  }
  return dedupeLineasDesglose(out);
}
