/**
 * Cuadrante de personal (turnos planificados vs fichajes reales).
 *
 * GET /api/personal/cuadrante?local_ids=id1,id2,...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Compat: local_id=uno solo o varios repetidos (?local_id=a&local_id=b).
 *
 * Flujo:
 *  1. Lee igp_Locales por cada id (factorial_location_id obligatorio).
 *  2. Turnos planificados por ubicación y se concatenan.
 *  3. Lista empleados en Dynamo (sync Factorial) → unión de IDs con los del plan.
 *  4. Fichajes + contratos Factorial para ese conjunto (paginado por trozos de employee_ids).
 *  5. Cruce por local: plan + fichajes atribuibles por ubicación del fichaje o sede del empleado.
 */

import { Router } from 'express';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, tables } from '../lib/db.js';
import { getAllEmployees } from '../lib/dynamo/personalEmployees.js';
import {
  fetchPlannedShifts,
  fetchAttendanceShifts,
  fetchContractVersions,
} from '../lib/personal/factorialClient.js';
import {
  ultimoContratoPorEmpleado,
  construirCuadrantePorLocales,
} from '../lib/personal/cuadrante.js';

const router = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** id_Locales únicos desde local_ids=a,b o local_id repetido. */
function parseLocalIds(query) {
  const ids = new Set();
  const pushMany = (v) => {
    if (v == null || v === '') return;
    if (Array.isArray(v)) {
      for (const x of v) pushMany(x);
      return;
    }
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((id) => ids.add(id));
  };
  pushMany(query.local_ids);
  pushMany(query.local_id);
  return [...ids];
}

router.get('/personal/cuadrante', async (req, res) => {
  const localIds = parseLocalIds(req.query);
  const from = req.query.from != null ? String(req.query.from) : '';
  const to = req.query.to != null ? String(req.query.to) : '';

  if (localIds.length === 0) {
    return res.status(400).json({ error: 'Indica al menos un local (local_ids o local_id)' });
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    return res.status(400).json({ error: 'from y to deben tener formato YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from debe ser menor o igual que to' });
  }

  try {
    const resolved = [];
    for (const localId of localIds) {
      const got = await docClient.send(new GetCommand({
        TableName: tables.locales,
        Key: { id_Locales: localId },
      }));
      const local = got.Item;
      if (!local) {
        return res.status(404).json({ error: `Local no encontrado: ${localId}` });
      }
      const factorialLocationId = local.factorial_location_id;
      if (!factorialLocationId) {
        return res.status(400).json({
          error: `El local "${local.nombre || localId}" no tiene factorial_location_id configurado.`,
        });
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
      const chunk = await fetchPlannedShifts({
        locationId: r.factorial_location_id,
        from,
        to,
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
      fetchAttendanceShifts({ employeeIds, from, to }),
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
      from,
      to,
      localesOrden: resolved,
    });

    res.json({
      ok: true,
      local_ids: resolved.map((r) => r.local_id),
      locales: resolved,
      local_id: resolved.length === 1 ? resolved[0].local_id : undefined,
      factorial_location_id: resolved.length === 1 ? resolved[0].factorial_location_id : undefined,
      from,
      to,
      totales,
      por_local,
    });
  } catch (err) {
    console.error('[cuadrante] error:', err);
    res.status(500).json({ ok: false, error: err.message || 'Error al construir cuadrante' });
  }
});

export default router;
