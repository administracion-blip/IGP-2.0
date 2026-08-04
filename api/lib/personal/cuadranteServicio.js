/**
 * Servicio reutilizable del cuadrante (plan Factorial vs fichajes reales).
 * Extraído de `api/routes/cuadrante.js` para poder usarlo desde Informes IA
 * sin duplicar la carga de plan/attendance/contratos.
 */
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../db.js';
import { getAllEmployees } from '../dynamo/personalEmployees.js';
import {
  fetchPlannedShifts,
  fetchAttendanceShifts,
  fetchContractVersions,
} from './factorialClient.js';
import {
  ultimoContratoPorEmpleado,
  construirCuadrantePorLocales,
} from './cuadrante.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const FLAGS_SOSPECHOSOS = ['sin_planificado', 'sin_real', 'tarde', 'salida_anticipada'];

/** Error con status HTTP para mapear en la ruta. */
export class CuadranteServicioError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CuadranteServicioError';
    this.status = status;
  }
}

/** Mapa employee_id (string) → location_id Factorial de la ficha del empleado (sede por defecto). */
function mapEmpleadoLocationPorEmp(empleadosRows) {
  const m = new Map();
  for (const e of empleadosRows || []) {
    const id = e.employee_id != null ? String(e.employee_id) : null;
    if (!id) continue;
    const lid = e.location_id;
    const n =
      lid != null && lid !== ''
        ? Number.parseInt(String(lid).trim(), 10)
        : NaN;
    m.set(id, Number.isFinite(n) ? n : null);
  }
  return m;
}

/**
 * Carga el cuadrante para uno o más locales IGP en el rango [from, to].
 *
 * @param {{ localIds: string[], from: string, to: string }} args
 * @returns {Promise<{
 *   ok: true,
 *   local_ids: string[],
 *   locales: Array<{ local_id: string, nombre: string, factorial_location_id: string }>,
 *   local_id?: string,
 *   factorial_location_id?: string,
 *   from: string,
 *   to: string,
 *   totales: object,
 *   por_local: Array,
 * }>}
 */
export async function obtenerCuadrantePorLocales({ localIds, from, to }) {
  const ids = [...new Set((localIds || []).map((x) => String(x).trim()).filter(Boolean))];
  const fromStr = from != null ? String(from) : '';
  const toStr = to != null ? String(to) : '';

  if (ids.length === 0) {
    throw new CuadranteServicioError(400, 'Indica al menos un local (local_ids o local_id)');
  }
  if (!ISO_DATE.test(fromStr) || !ISO_DATE.test(toStr)) {
    throw new CuadranteServicioError(400, 'from y to deben tener formato YYYY-MM-DD');
  }
  if (fromStr > toStr) {
    throw new CuadranteServicioError(400, 'from debe ser menor o igual que to');
  }

  const resolved = [];
  for (const localId of ids) {
    // eslint-disable-next-line no-await-in-loop
    const got = await docClient.send(new GetCommand({
      TableName: tables.locales,
      Key: { id_Locales: localId },
    }));
    const local = got.Item;
    if (!local) {
      throw new CuadranteServicioError(404, `Local no encontrado: ${localId}`);
    }
    const factorialLocationId = local.factorial_location_id;
    if (!factorialLocationId) {
      throw new CuadranteServicioError(
        400,
        `El local "${local.nombre || localId}" no tiene factorial_location_id configurado.`,
      );
    }
    resolved.push({
      local_id: localId,
      nombre: local.nombre || localId,
      factorial_location_id: String(factorialLocationId),
    });
  }

  const empleadosLocales = await getAllEmployees(docClient, tables.empleados).catch(() => []);

  let planned = [];
  for (const r of resolved) {
    // eslint-disable-next-line no-await-in-loop
    const chunk = await fetchPlannedShifts({
      locationId: r.factorial_location_id,
      from: fromStr,
      to: toStr,
    });
    for (const s of chunk) {
      planned.push({
        ...s,
        __igp_local_id: r.local_id,
        __igp_local_nombre: r.nombre,
      });
    }
  }

  const idsPlan = planned.map((s) => s.employee_id).filter((v) => v != null);
  const idsDb = (empleadosLocales || [])
    .map((e) => e.employee_id)
    .filter((v) => v != null && String(v).trim() !== '');
  const employeeIds = [...new Set([...idsPlan, ...idsDb])];

  const empleadoLocationPorEmp = mapEmpleadoLocationPorEmp(empleadosLocales);

  const [attendance, contracts] = await Promise.all([
    fetchAttendanceShifts({ employeeIds, from: fromStr, to: toStr }),
    fetchContractVersions({ employeeIds }),
  ]);

  const contratoPorEmp = ultimoContratoPorEmpleado(contracts);

  const empleadoNombre = new Map();
  for (const e of empleadosLocales || []) {
    const id = e.employee_id != null ? String(e.employee_id) : null;
    if (!id) continue;
    const nombre = e.full_name || [e.first_name, e.last_name].filter(Boolean).join(' ') || `Empleado ${id}`;
    empleadoNombre.set(id, nombre);
  }

  const { totales, por_local } = construirCuadrantePorLocales({
    plannedTagged: planned,
    attendance,
    contratoPorEmp,
    empleadoNombre,
    empleadoLocationPorEmp,
    from: fromStr,
    to: toStr,
    localesOrden: resolved,
  });

  return {
    ok: true,
    local_ids: resolved.map((r) => r.local_id),
    locales: resolved,
    local_id: resolved.length === 1 ? resolved[0].local_id : undefined,
    factorial_location_id: resolved.length === 1 ? resolved[0].factorial_location_id : undefined,
    from: fromStr,
    to: toStr,
    totales,
    por_local,
  };
}

/**
 * Filas del cuadrante con flags sospechosos (ejecutor Factorial: plan/attendance).
 *
 * @param {object} resultadoCuadrante - salida de `obtenerCuadrantePorLocales`
 * @param {{ fecha?: string, flags?: string[] }} [opts]
 */
export function extraerFichajesSospechosos(resultadoCuadrante, opts = {}) {
  const fechaFiltro = opts.fecha && ISO_DATE.test(String(opts.fecha))
    ? String(opts.fecha).slice(0, 10)
    : null;
  const flagsFiltro = Array.isArray(opts.flags) && opts.flags.length > 0
    ? opts.flags
    : FLAGS_SOSPECHOSOS;
  const flagSet = new Set(flagsFiltro);

  const porFlag = {
    sin_planificado: 0,
    sin_real: 0,
    tarde: 0,
    salida_anticipada: 0,
  };
  const items = [];

  for (const loc of resultadoCuadrante?.por_local || []) {
    const localId = String(loc.local_id || '');
    const localNombre = String(loc.nombre || localId);
    for (const dia of loc.dias || []) {
      const fechaDia = String(dia.fecha || '').slice(0, 10);
      if (fechaFiltro && fechaDia !== fechaFiltro) continue;
      for (const fila of dia.filas || []) {
        const flags = (fila.flags || []).filter((f) => flagSet.has(f));
        if (flags.length === 0) continue;
        for (const f of flags) {
          if (Object.prototype.hasOwnProperty.call(porFlag, f)) porFlag[f] += 1;
        }
        items.push({
          localId,
          localNombre,
          employee_id: fila.employee_id != null ? String(fila.employee_id) : null,
          nombre: String(fila.nombre || `Empleado ${fila.employee_id || '?'}`),
          flags,
          planificado: fila.planificado || null,
          real: fila.real || null,
          desviacion_min: Number(fila.desviacion_min) || 0,
          fecha: fechaDia,
        });
      }
    }
  }

  items.sort((a, b) => {
    const byLocal = a.localNombre.localeCompare(b.localNombre, 'es', { sensitivity: 'base' });
    if (byLocal !== 0) return byLocal;
    return a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' });
  });

  return {
    fecha: fechaFiltro,
    resumen: {
      total: items.length,
      porFlag,
    },
    items,
  };
}
