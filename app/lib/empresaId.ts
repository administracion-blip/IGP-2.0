/**
 * Identificadores del maestro `igp_Empresas`: cálculo del próximo `id_empresa`
 * libre, creación tolerante a colisiones de id y resolución de un id a partir
 * del nombre para los módulos que todavía guardan la empresa por nombre.
 *
 * El backend exige `id_empresa` en `POST /api/empresas` y responde `409` si ese
 * id ya existe. Como el id se calcula en cliente a partir del catálogo cargado,
 * basta con que el catálogo esté desactualizado (o que no llegara a cargarse por
 * un fallo de red) para que el alta choque una y otra vez con el mismo id. Por
 * eso `crearEmpresaConIdLibre` recarga el maestro y reintenta una sola vez.
 */
import { apiFetch } from '../utils/api';
import { formatId6 } from '../utils/idFormat';

/** Forma mínima de una empresa del maestro para calcular ids y refrescar catálogos. */
export type EmpresaMaestro = {
  id_empresa?: string;
  Nombre?: string;
  Cif?: string;
  Sede?: string;
};

/** Cuerpo del alta: todos los atributos de la tabla (`Etiqueta` es array). */
export type CuerpoAltaEmpresa = Record<string, string | string[]>;

type RespuestaPost =
  | { ok: true; empresa: EmpresaMaestro }
  | { ok: false; status: number; error: string };

/**
 * Próximo `id_empresa` libre: máximo id existente + 1, en formato de 6 dígitos.
 * Misma fórmula que usa el maestro `app/(app)/empresas.tsx`.
 */
export function calcularProximoIdEmpresa(empresas: EmpresaMaestro[]): string {
  if (!empresas.length) return formatId6(1);
  const ids = empresas.map((e) => {
    const n = parseInt(String(e.id_empresa ?? 0).replace(/^0+/, ''), 10);
    return Number.isNaN(n) ? 0 : n;
  });
  return formatId6(Math.max(0, ...ids) + 1);
}

/**
 * Id de empresa en el formato de 6 dígitos del maestro. Devuelve cadena vacía
 * cuando no hay id utilizable (vacío, no numérico o cero), para poder
 * distinguir «sin empresa» de una empresa real: los ids empiezan en `000001`.
 */
export function normalizarIdEmpresa(val: string | number | null | undefined): string {
  const raw = String(val ?? '').trim();
  if (!raw) return '';
  const n = parseInt(raw.replace(/^0+/, '') || '0', 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  return formatId6(n);
}

/**
 * Clave de comparación de nombres de empresa: los nombres que otros módulos
 * guardan como texto (p. ej. `empresa` en locales) se teclearon a mano.
 *
 * Mismo criterio que el backend (`api/scripts/migrar-locales-id-empresa.js` y el
 * cruce de marketing): sin acentos, en mayúsculas y con puntos y comas tratados
 * como separadores, para que «GRUPO PARIPE, S.L.» case con «Grupo Paripe S.L.».
 * Si las dos capas normalizaran distinto, la migración resolvería vínculos que
 * la pantalla marcaría como rotos.
 */
export function claveNombreEmpresa(nombre: string | null | undefined): string {
  return String(nombre ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Por qué un nombre guardado en un local casa (o no) con el maestro de empresas. */
export type EstadoResolucionEmpresa =
  /** El local no tiene nombre de empresa. */
  | 'sin-nombre'
  /** Exactamente una empresa del maestro casa: el id es fiable. */
  | 'resuelta'
  /** Varias empresas comparten ese nombre con ids distintos: no se puede adivinar. */
  | 'ambigua'
  /** Casa por nombre, pero ninguna candidata tiene un id utilizable. */
  | 'sin-id'
  /** Ninguna empresa del maestro se llama así. */
  | 'sin-coincidencia';

/**
 * Cruza el nombre de empresa guardado en un local con el maestro.
 *
 * Solo devuelve id cuando casa **exactamente una** empresa, igual que hacen la
 * migración y el cruce de marketing: el maestro admite dos sociedades con el
 * mismo nombre y distinto CIF, y elegir la primera del escaneo escribiría un
 * vínculo arbitrario en el local al primer guardado.
 */
export function resolverEmpresaPorNombre(
  nombre: string | null | undefined,
  empresas: EmpresaMaestro[],
): { id: string; estado: EstadoResolucionEmpresa } {
  const clave = claveNombreEmpresa(nombre);
  if (!clave) return { id: '', estado: 'sin-nombre' };
  const candidatas = empresas.filter((e) => claveNombreEmpresa(e.Nombre) === clave);
  if (candidatas.length === 0) return { id: '', estado: 'sin-coincidencia' };
  const ids = Array.from(
    new Set(candidatas.map((e) => normalizarIdEmpresa(e.id_empresa)).filter((id) => id !== '')),
  );
  if (ids.length === 1) return { id: ids[0], estado: 'resuelta' };
  if (ids.length === 0) return { id: '', estado: 'sin-id' };
  return { id: '', estado: 'ambigua' };
}

/**
 * `id_empresa` del maestro que corresponde a un nombre guardado, o cadena vacía
 * si no hay nombre o el nombre no casa con exactamente una empresa.
 */
export function resolverIdEmpresaPorNombre(
  nombre: string | null | undefined,
  empresas: EmpresaMaestro[],
): string {
  return resolverEmpresaPorNombre(nombre, empresas).id;
}

/**
 * ¿El 409 es por id ocupado o por CIF duplicado?
 *
 * El endpoint solo devuelve 409 en dos casos: «CIF ya existe» (error legítimo
 * del usuario, reintentar no arregla nada) y «Ya existe una empresa con el id
 * NNNNNN». Discriminamos descartando el mensaje de CIF en vez de casar el texto
 * exacto del id, para no depender de su redacción.
 */
function esConflictoDeIdOcupado(status: number, mensaje: string): boolean {
  if (status !== 409) return false;
  return !/\bcif\b/i.test(mensaje);
}

async function postEmpresa(body: CuerpoAltaEmpresa): Promise<RespuestaPost> {
  const res = await apiFetch('/api/empresas', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    empresa?: EmpresaMaestro;
  };
  if (!res.ok) {
    return { ok: false, status: res.status, error: data?.error || 'No se pudo crear la empresa' };
  }
  return { ok: true, empresa: data?.empresa || {} };
}

async function listarEmpresas(): Promise<EmpresaMaestro[]> {
  const res = await apiFetch('/api/empresas');
  const data = (await res.json().catch(() => ({}))) as { empresas?: EmpresaMaestro[] };
  if (!res.ok || !Array.isArray(data.empresas)) throw new Error('No se pudo cargar el maestro de empresas');
  return data.empresas;
}

/**
 * Crea la empresa y, si el id calculado estaba ocupado, recarga el maestro,
 * recalcula el próximo id libre y reintenta **una sola vez**. Devuelve la
 * empresa creada y el id realmente usado (puede no ser el de `body`).
 *
 * Lanza `Error` con el mensaje del backend si el alta no sale adelante.
 */
export async function crearEmpresaConIdLibre(
  body: CuerpoAltaEmpresa,
): Promise<{ empresa: EmpresaMaestro; idUsado: string }> {
  const idInicial = String(body.id_empresa ?? '').trim();
  const primerIntento = await postEmpresa(body);
  if (primerIntento.ok) {
    const idUsado = primerIntento.empresa.id_empresa || idInicial;
    return { empresa: primerIntento.empresa, idUsado };
  }
  if (!esConflictoDeIdOcupado(primerIntento.status, primerIntento.error)) {
    throw new Error(primerIntento.error);
  }

  let idLibre = '';
  try {
    idLibre = calcularProximoIdEmpresa(await listarEmpresas());
  } catch {
    // Sin catálogo fresco no podemos proponer otro id: mejor el error original.
    throw new Error(primerIntento.error);
  }
  if (!idLibre || idLibre === idInicial) throw new Error(primerIntento.error);

  const reintento = await postEmpresa({ ...body, id_empresa: idLibre });
  if (!reintento.ok) throw new Error(reintento.error);
  return { empresa: reintento.empresa, idUsado: reintento.empresa.id_empresa || idLibre };
}
