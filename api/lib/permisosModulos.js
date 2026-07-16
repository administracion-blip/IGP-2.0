import { hasAnyPermission, hasPermission } from '../middleware/auth.js';

export async function puedeLeerActuaciones(user) {
  return hasAnyPermission(user, 'actuaciones.ver', 'planning_dia.actuaciones', 'actuaciones.programacion');
}

export async function puedeSeguimientoPlanningActuacion(user) {
  return hasAnyPermission(user, 'actuaciones.editar', 'planning_dia.actuaciones');
}

export async function puedeFirmarActuacionApi(user) {
  return hasAnyPermission(user, 'actuaciones.firma', 'planning_dia.actuaciones');
}

export async function puedeLeerActivacionesDia(user) {
  return hasAnyPermission(user, 'activaciones.ver', 'planning_dia.activaciones');
}

export async function puedeArqueoCaja(user) {
  return hasAnyPermission(user, 'planning_dia.arqueo', 'cierres.ver');
}

/** Solo campos operativos del día (observaciones / valoración). */
export function esActualizacionSeguimiento(body) {
  const keys = Object.keys(body || {}).filter((k) => body[k] !== undefined && k !== 'forzar_conflicto');
  if (keys.length === 0) return false;
  const permitidas = new Set(['observaciones', 'valoracion']);
  return keys.every((k) => permitidas.has(k));
}

export { hasPermission };