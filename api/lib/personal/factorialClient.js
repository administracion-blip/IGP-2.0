/**
 * Cliente HTTP de solo lectura para el API de Factorial HR.
 * Documentación: https://apidoc.factorialhr.com/reference
 *
 * Paginación: (1) cuerpo JSON `{ data, meta }` con `meta.has_next_page` + `meta.end_cursor` → `after_id`;
 * (2) cabecera `Link` rel=next como respaldo.
 * Únicamente realiza lecturas (GET); nunca escribe en Factorial.
 */

const API_VERSION = process.env.FACTORIAL_API_VERSION || '2025-10-01';
const BASE_URL = `https://api.factorialhr.com/api/${API_VERSION}`;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

function getApiKey() {
  const key = process.env.FACTORIAL_API_KEY || '';
  if (!key) throw new Error('[factorial] FACTORIAL_API_KEY no configurada');
  return key;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(tid);
    return res;
  } catch (err) {
    clearTimeout(tid);
    throw err;
  }
}

function parseNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = part.trim().match(/<([^>]+)>;\s*rel=(?:"next"|next)/i);
    if (m) return m[1];
  }
  return null;
}

/** Respuesta estándar Factorial: `{ data: [...], meta: { has_next_page, end_cursor, ... } }`. */
function extractItemsAndMeta(body) {
  if (
    body != null &&
    typeof body === 'object' &&
    Array.isArray(body.data) &&
    body.meta != null &&
    typeof body.meta === 'object'
  ) {
    return { items: body.data, meta: body.meta };
  }
  const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [body];
  return { items, meta: null };
}

/** Siguiente URL usando cursor (`after_id` = `end_cursor` de la página anterior). */
function nextUrlFromMeta(currentUrl, meta) {
  if (!meta?.has_next_page || meta.end_cursor == null || String(meta.end_cursor).trim() === '') {
    return null;
  }
  const u = new URL(currentUrl);
  u.searchParams.set('after_id', String(meta.end_cursor).trim());
  if (!u.searchParams.has('limit')) u.searchParams.set('limit', '100');
  return u.href;
}

/**
 * GET genérico con reintentos y paginación automática.
 * Devuelve un array con todos los elementos acumulados de todas las páginas.
 */
async function getAll(path) {
  const apiKey = getApiKey();
  let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const all = [];

  while (url) {
    let lastError;
    let res;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[factorial] Reintento ${attempt}/${MAX_RETRIES} GET ${url}`);
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
        }
        res = await fetchWithTimeout(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-api-key': apiKey,
          },
        });
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') || 5);
          console.warn(`[factorial] Rate-limited, esperando ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          lastError = new Error('429 Too Many Requests');
          continue;
        }
        if (res.status >= 500) throw new Error(`Factorial respondió ${res.status}`);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Factorial ${res.status}: ${text.slice(0, 300)}`);
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;

    const body = await res.json();
    const { items, meta } = extractItemsAndMeta(body);
    all.push(...items);

    url = nextUrlFromMeta(url, meta) || parseNextLink(res.headers.get('link'));
  }

  return all;
}

/** Obtiene todos los empleados (paginados). */
export async function fetchAllEmployees() {
  console.log('[factorial] Descargando empleados…');
  const employees = await getAll('/resources/employees/employees');
  console.log(`[factorial] ${employees.length} empleados descargados`);
  return employees;
}

/** Obtiene un empleado por su ID. */
export async function fetchEmployeeById(id) {
  const apiKey = getApiKey();
  const res = await fetchWithTimeout(`${BASE_URL}/resources/employees/employees/${id}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Factorial ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Construye una query string. Para arrays usa `nombre[]=v1&nombre[]=v2`.
 * La clave NO debe llevar `[]` al final (p. ej. `employee_ids`, no `employee_ids[]`).
 */
function buildQuery(params) {
  const parts = [];
  for (const [key, val] of Object.entries(params)) {
    if (val == null || val === '') continue;
    if (Array.isArray(val)) {
      for (const v of val) {
        if (v == null || v === '') continue;
        parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Turnos planificados (shift_management) para una location y rango de fechas.
 * @param {{ locationId: string|number, from: string, to: string }} args
 *   from/to en formato YYYY-MM-DD.
 */
export async function fetchPlannedShifts({ locationId, from, to }) {
  if (locationId == null || locationId === '') return [];
  // Docs shift_management/shifts: `location_ids[]` (ints), `start_at`, `end_at`.
  // Usar clave `location_ids` sin []: buildQuery añade `[]=valor` por elemento (si la clave ya lleva [], sale employee_ids[][] y Factorial 400).
  const loc =
    typeof locationId === 'number' && Number.isFinite(locationId)
      ? locationId
      : Number.parseInt(String(locationId).trim(), 10);
  if (!Number.isFinite(loc)) {
    console.warn('[factorial] fetchPlannedShifts: locationId no es un entero válido:', locationId);
    return [];
  }
  const qs = buildQuery({
    location_ids: [loc],
    start_at: from,
    end_at: to,
  });
  console.log(`[factorial] Descargando turnos planificados (location=${locationId}, ${from}→${to})…`);
  const items = await getAll(`/resources/shift_management/shifts${qs}`);
  console.log(`[factorial] ${items.length} turnos planificados`);
  return items;
}

/**
 * Fichajes reales (attendance/shifts).
 * Nota: este endpoint NO acepta filtro por location; hay que pasarle los employee_ids.
 * @param {{ employeeIds: Array<string|number>, from: string, to: string }} args
 */
const ATTENDANCE_EMPLOYEE_CHUNK = 55;

export async function fetchAttendanceShifts({ employeeIds, from, to }) {
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
  const ids = [...new Set(
    employeeIds
      .map((id) => {
        const n = typeof id === 'number' && Number.isFinite(id) ? id : Number.parseInt(String(id).trim(), 10);
        return Number.isFinite(n) ? n : null;
      })
      .filter((id) => id != null),
  )];
  if (ids.length === 0) return [];

  console.log(`[factorial] Descargando fichajes (${ids.length} empleados, ${from}→${to})…`);
  const all = [];
  for (let i = 0; i < ids.length; i += ATTENDANCE_EMPLOYEE_CHUNK) {
    const slice = ids.slice(i, i + ATTENDANCE_EMPLOYEE_CHUNK);
    const qs = buildQuery({
      employee_ids: slice,
      start_on: from,
      end_on: to,
    });
    const items = await getAll(`/resources/attendance/shifts${qs}`);
    all.push(...items);
  }
  console.log(`[factorial] ${all.length} fichajes`);
  return all;
}

/**
 * Versiones de contrato para un conjunto de empleados.
 * Devuelve TODAS las versiones; el caller debe quedarse con la más reciente por empleado.
 * @param {{ employeeIds: Array<string|number> }} args
 */
export async function fetchContractVersions({ employeeIds }) {
  if (!Array.isArray(employeeIds) || employeeIds.length === 0) return [];
  const ids = [...new Set(
    employeeIds
      .map((id) => {
        const n = typeof id === 'number' && Number.isFinite(id) ? id : Number.parseInt(String(id).trim(), 10);
        return Number.isFinite(n) ? n : null;
      })
      .filter((id) => id != null),
  )];
  if (ids.length === 0) return [];
  console.log(`[factorial] Descargando contratos (${ids.length} empleados)…`);
  const all = [];
  for (let i = 0; i < ids.length; i += ATTENDANCE_EMPLOYEE_CHUNK) {
    const slice = ids.slice(i, i + ATTENDANCE_EMPLOYEE_CHUNK);
    const qs = buildQuery({ employee_ids: slice });
    const items = await getAll(`/resources/contracts/contract_versions${qs}`);
    all.push(...items);
  }
  console.log(`[factorial] ${all.length} versiones de contrato`);
  return all;
}
