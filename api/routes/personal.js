/**
 * Rutas del módulo Personal (empleados vía Factorial HR).
 *
 * POST /api/personal/employees/sync  — Lanza sincronización Factorial → DynamoDB
 * GET  /api/personal/employees       — Lista empleados almacenados
 * GET  /api/personal/employees/:id   — Detalle de un empleado
 */

import { Router } from 'express';
import { docClient, tables } from '../lib/db.js';
import { syncEmployees } from '../lib/personal/employeesSync.js';
import { getAllEmployees, getEmployeeById } from '../lib/dynamo/personalEmployees.js';

const router = Router();
const TABLE = tables.empleados;

/** POST /api/personal/employees/sync */
router.post('/personal/employees/sync', async (_req, res) => {
  try {
    console.log('[personal] Iniciando sincronización de empleados…');
    const result = await syncEmployees(docClient, TABLE);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[personal] Error en sincronización:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/personal/employees */
router.get('/personal/employees', async (_req, res) => {
  try {
    const items = await getAllEmployees(docClient, TABLE);
    const employees = items.map(sanitizeForApi);
    employees.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    res.json({ ok: true, employees });
  } catch (err) {
    console.error('[personal] Error al listar empleados:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /api/personal/employees/:id */
router.get('/personal/employees/:id', async (req, res) => {
  try {
    const item = await getEmployeeById(docClient, TABLE, req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Empleado no encontrado' });
    res.json({ ok: true, employee: sanitizeForApi(item) });
  } catch (err) {
    console.error('[personal] Error al obtener empleado:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Excluye raw_factorial_json de la respuesta API (peso innecesario). */
function sanitizeForApi(item) {
  if (!item) return item;
  const { raw_factorial_json, ...rest } = item;
  return rest;
}

export default router;
