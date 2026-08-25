/**
 * Detección de incidencias de mantenimiento similares (anti-duplicados).
 * Solo texto: sin Dynamo. El router filtra por local/estado/origen y rankea aquí.
 */

const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'a', 'un', 'una', 'los', 'las', 'del', 'al',
  'por', 'para', 'con', 'se', 'que', 'es', 'su', 'sus', 'lo', 'le', 'les',
  'me', 'te', 'nos', 'os', 'mi', 'tu', 'o', 'u', 'e', 'ni', 'ya', 'si',
  'no', 'como', 'mas', 'muy', 'esta', 'este', 'esto', 'hay', 'ser', 'ha',
  'han', 'he', 'son', 'fue', 'era',
]);

const ESTADOS_CANDIDATOS = new Set(['Nuevo', 'Programado']);
const MAX_SIMILARES = 5;
const MIN_TOKENS_COMUNES = 2;
const MIN_TOKENS_QUERY_JACCARD = 2;
const UMBRAL_JACCARD = 0.4;

/** Minúsculas, sin tildes (NFD), solo letras/números/espacios. */
export function normalizarTexto(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokens únicos ≥ 3 chars, sin stopwords cortas en español.
 * @returns {string[]}
 */
export function tokenizar(texto) {
  const norm = normalizarTexto(texto);
  if (!norm) return [];
  const vistos = new Set();
  const tokens = [];
  for (const t of norm.split(' ')) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    if (vistos.has(t)) continue;
    vistos.add(t);
    tokens.push(t);
  }
  return tokens;
}

/** Número de tokens en común (intersección de conjuntos). */
export function scoreTokensComunes(tokensQuery, tokensCand) {
  const setC = new Set(tokensCand);
  let n = 0;
  for (const t of tokensQuery) {
    if (setC.has(t)) n += 1;
  }
  return n;
}

/** Jaccard = |A∩B| / |A∪B|. */
export function jaccardTokens(tokensQuery, tokensCand) {
  const setQ = new Set(tokensQuery);
  const setC = new Set(tokensCand);
  if (setQ.size === 0 && setC.size === 0) return 0;
  let inter = 0;
  for (const t of setQ) {
    if (setC.has(t)) inter += 1;
  }
  const union = setQ.size + setC.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Similar si ≥ 2 tokens en común, o (query ≥ 2 tokens y Jaccard ≥ 0.4).
 * @returns {{ similar: boolean, score: number }}
 */
export function evaluarSimilitud(tokensQuery, tokensCand) {
  const score = scoreTokensComunes(tokensQuery, tokensCand);
  if (score >= MIN_TOKENS_COMUNES) return { similar: true, score };
  if (
    tokensQuery.length >= MIN_TOKENS_QUERY_JACCARD &&
    jaccardTokens(tokensQuery, tokensCand) >= UMBRAL_JACCARD
  ) {
    return { similar: true, score };
  }
  return { similar: false, score };
}

/**
 * Candidatos anti-duplicado: INC, Nuevo|Programado, no recurrentes.
 */
export function esCandidatoDuplicado(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.tipo !== 'INC') return false;
  if (!ESTADOS_CANDIDATOS.has(item.estado)) return false;
  if (item.origen === 'recurrente') return false;
  return true;
}

/**
 * Rankea candidatos similares al query. Zona solo como tie-break (misma zona primero).
 * @returns {Array<{ id_incidencia, titulo, descripcion, zona, estado, prioridad_reportada, fecha_creacion, fecha_programada, fotos, score }>}
 */
export function rankearSimilares({ titulo, descripcion = '', zona = '', candidatos = [] }) {
  const tokensQuery = tokenizar(`${titulo ?? ''} ${descripcion ?? ''}`);
  const zonaQuery = String(zona ?? '').trim().toLowerCase();

  const ranked = [];
  for (const c of candidatos) {
    if (!esCandidatoDuplicado(c)) continue;
    const tokensCand = tokenizar(`${c.titulo ?? ''} ${c.descripcion ?? ''}`);
    const { similar, score } = evaluarSimilitud(tokensQuery, tokensCand);
    if (!similar) continue;
    ranked.push({
      id_incidencia: c.id_incidencia,
      titulo: c.titulo ?? '',
      descripcion: c.descripcion ?? '',
      zona: c.zona ?? '',
      estado: c.estado,
      prioridad_reportada: c.prioridad_reportada ?? null,
      fecha_creacion: c.fecha_creacion ?? null,
      fecha_programada: c.fecha_programada ?? null,
      fotos: Array.isArray(c.fotos) ? c.fotos : [],
      score,
      _mismaZona: zonaQuery && String(c.zona ?? '').trim().toLowerCase() === zonaQuery ? 1 : 0,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b._mismaZona !== a._mismaZona) return b._mismaZona - a._mismaZona;
    return String(b.fecha_creacion || '').localeCompare(String(a.fecha_creacion || ''));
  });

  return ranked.slice(0, MAX_SIMILARES).map(({ _mismaZona, ...rest }) => rest);
}
