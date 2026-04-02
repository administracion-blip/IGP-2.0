/**
 * Orquestador de sincronización Factorial HR → DynamoDB.
 *
 * 1. Descarga todos los empleados de Factorial.
 * 2. Normaliza cada registro al esquema de Igp_Empleados.
 * 3. Upsert masivo en DynamoDB.
 */

import { fetchAllEmployees } from './factorialClient.js';
import { upsertEmployeesBatch } from '../dynamo/personalEmployees.js';

/**
 * Campos normalizados que se extraen de la respuesta de Factorial.
 * Cada key es el nombre destino; el valor es un array de posibles claves origen.
 */
const FIELD_MAP = {
  first_name: ['first_name', 'firstName'],
  last_name: ['last_name', 'lastName'],
  full_name: ['full_name', 'fullName'],
  preferred_name: ['preferred_name', 'preferredName'],
  email: ['email'],
  login_email: ['login_email', 'loginEmail'],
  birthday_on: ['birthday_on', 'birthdayOn'],
  start_date: ['start_date', 'startDate'],
  terminated_on: ['terminated_on', 'terminatedOn'],
  termination_reason: ['termination_reason', 'terminationReason'],
  phone_number: ['phone_number', 'phoneNumber'],
  gender: ['gender'],
  nationality: ['nationality'],
  identifier: ['identifier'],
  identifier_type: ['identifier_type', 'identifierType'],
  social_security_number: ['social_security_number', 'socialSecurityNumber'],
  company_id: ['company_id', 'companyId'],
  legal_entity_id: ['legal_entity_id', 'legalEntityId'],
  manager_id: ['manager_id', 'managerId'],
  location_id: ['location_id', 'locationId'],
  team_ids: ['team_ids', 'teamIds'],
  timeoff_manager_id: ['timeoff_manager_id', 'timeoffManagerId'],
  city: ['city'],
  state: ['state'],
  country: ['country'],
  postal_code: ['postal_code', 'postalCode'],
  address_line_1: ['address_line_1', 'addressLine1'],
};

function pick(src, keys) {
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/**
 * Normaliza un empleado de Factorial al esquema de DynamoDB.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeEmployee(raw) {
  const id = raw.id ?? raw.Id ?? raw.employee_id;
  if (id == null) return null;

  const employeeId = String(id);
  const now = new Date().toISOString();

  const item = {
    PK: `EMPLOYEE#${employeeId}`,
    SK: 'METADATA',
    employee_id: employeeId,
    source: 'factorial',
    synced_at: now,
    updated_at: now,
  };

  for (const [dest, srcKeys] of Object.entries(FIELD_MAP)) {
    const val = pick(raw, srcKeys);
    if (val !== null) item[dest] = val;
  }

  if (!item.full_name) {
    const fullName = [item.first_name, item.last_name].filter(Boolean).join(' ');
    if (fullName) item.full_name = fullName;
  }

  item.active = raw.active != null ? Boolean(raw.active) : (raw.terminated_on == null && raw.terminatedOn == null);

  item.raw_factorial_json = JSON.stringify(raw);

  return item;
}

/**
 * Ejecuta la sincronización completa.
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} docClient
 * @param {string} tableName
 * @returns {{ total: number, synced: number }}
 */
export async function syncEmployees(docClient, tableName) {
  const rawEmployees = await fetchAllEmployees();
  console.log(`[personal-sync] ${rawEmployees.length} empleados recibidos de Factorial`);

  const normalized = rawEmployees.map(normalizeEmployee).filter(Boolean);
  console.log(`[personal-sync] ${normalized.length} empleados normalizados`);

  const synced = await upsertEmployeesBatch(docClient, tableName, normalized);
  console.log(`[personal-sync] ${synced} empleados escritos en DynamoDB (${tableName})`);

  return { total: rawEmployees.length, synced };
}
