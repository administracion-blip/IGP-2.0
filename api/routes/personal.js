/**
 * Rutas del módulo Personal (empleados vía Factorial HR).
 *
 * POST /api/personal/employees/sync  — Lanza sincronización Factorial → DynamoDB
 * GET  /api/personal/employees       — Lista empleados almacenados
 * GET  /api/personal/employees/:id   — Detalle de un empleado
 */

import { Router } from 'express';
import { docClient, tables } from '../lib/db.js';
import { hasAnyPermission, requireAnyPermission } from '../middleware/auth.js';
import { syncEmployees } from '../lib/personal/employeesSync.js';
import { getAllEmployees, getEmployeeById } from '../lib/dynamo/personalEmployees.js';
import { empleadoParaApi, PERMISOS_CONTACTO_EMPLEADO } from '../lib/personal/camposEmpleado.js';

const router = Router();
const TABLE = tables.empleados;

/** POST /api/personal/employees/sync */
router.post(
  '/personal/employees/sync',
  requireAnyPermission('ajustes.sincronizaciones.empleados', 'personal.ver'),
  async (req, res) => {
    req.log.info('[personal] Iniciando sincronización de empleados…');
    const result = await syncEmployees(docClient, TABLE);
    res.json({ ok: true, ...result });
  },
);

async function puedeVerContacto(req) {
  if (req.isInternal) return true;
  return hasAnyPermission(req.user, ...PERMISOS_CONTACTO_EMPLEADO);
}

/** GET /api/personal/employees */
router.get('/personal/employees', async (req, res) => {
  const conContacto = await puedeVerContacto(req);
  const items = await getAllEmployees(docClient, TABLE);
  const employees = items.map((it) => empleadoParaApi(it, { conContacto }));
  employees.sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  res.json({ ok: true, employees });
});

/** GET /api/personal/employees/:id */
router.get('/personal/employees/:id', async (req, res) => {
  const item = await getEmployeeById(docClient, TABLE, req.params.id);
  if (!item) return res.status(404).json({ error: 'Empleado no encontrado' });
  const conContacto = await puedeVerContacto(req);
  res.json({ ok: true, employee: empleadoParaApi(item, { conContacto }) });
});

export default router;
