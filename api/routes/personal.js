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
router.post('/personal/employees/sync', async (req, res) => {
  req.log.info('[personal] Iniciando sincronización de empleados…');
  const result = await syncEmployees(docClient, TABLE);
  res.json({ ok: true, ...result });
});

/** GET /api/personal/employees */
router.get('/personal/employees', async (_req, res) => {
  const items = await getAllEmployees(docClient, TABLE);
  const employees = items.map(sanitizeForApi);
  employees.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  res.json({ ok: true, employees });
});

/** GET /api/personal/employees/:id */
router.get('/personal/employees/:id', async (req, res) => {
  const item = await getEmployeeById(docClient, TABLE, req.params.id);
  if (!item) return res.status(404).json({ error: 'Empleado no encontrado' });
  res.json({ ok: true, employee: sanitizeForApi(item) });
});

/** Excluye raw_factorial_json de la respuesta API (peso innecesario). */
function sanitizeForApi(item) {
  if (!item) return item;
  const { raw_factorial_json, ...rest } = item;
  return rest;
}

export default router;
