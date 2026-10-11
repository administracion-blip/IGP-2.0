/**
 * Campos de `Igp_Empleados` que salen por la API.
 *
 * Lista blanca: la ficha sincronizada de Factorial trae datos personales (número
 * de la Seguridad Social, fecha de nacimiento, dirección, nacionalidad, género,
 * motivo de baja…) que ninguna pantalla usa; un campo nuevo en la sincronización
 * no debe salir por la API sin decidirlo aquí.
 */

/** Identifican y permiten elegir al empleado (selectores de limpieza, activos…). */
const CAMPOS_BASICOS = [
  'employee_id',
  'first_name',
  'last_name',
  'full_name',
  'preferred_name',
  'location_id',
  'company_id',
  'legal_entity_id',
  'team_ids',
  'manager_id',
  'start_date',
  'terminated_on',
  'active',
  'synced_at',
];

/** Contacto e identificación: listado de Personal y contraparte de Cashflow. */
const CAMPOS_CONTACTO = ['email', 'phone_number', 'identifier', 'identifier_type'];

export const PERMISOS_CONTACTO_EMPLEADO = ['personal.ver', 'cashflow.registrar'];

export function empleadoParaApi(item, { conContacto = false } = {}) {
  if (!item) return item;
  const campos = conContacto ? [...CAMPOS_BASICOS, ...CAMPOS_CONTACTO] : CAMPOS_BASICOS;
  const out = {};
  for (const campo of campos) {
    if (item[campo] !== undefined) out[campo] = item[campo];
  }
  return out;
}
