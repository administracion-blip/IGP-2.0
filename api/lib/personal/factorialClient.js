/**
 * Cliente HTTP de solo lectura para el API de Factorial HR.
 * Documentación: https://apidoc.factorialhr.com/reference
 *
 * Soporta paginación automática (header Link rel="next").
 * Únicamente realiza lecturas (GET); nunca escribe en Factorial.
 */

const API_VERSION = process.env.FACTORIAL_API_VERSION || '2025-01-01';
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
  const match = header.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
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
    const items = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [body];
    all.push(...items);

    url = parseNextLink(res.headers.get('link'));
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
