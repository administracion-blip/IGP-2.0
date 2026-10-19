/**
 * Política de acceso al CRUD genérico de `Igp_Ajustes` (`api/routes/ajustes.js`).
 *
 * La tabla mezcla configuración global, datos de cada usuario (favoritos) y
 * estado interno de los trabajos programados (cerrojos, secuencias, hashes de
 * tokens ICS). Por eso el permiso se decide **por clave** y no por ruta: cada
 * pantalla del frontend solo necesita las suyas.
 *
 * - Claves cerradas: ni se leen ni se escriben por el router genérico, tampoco
 *   el Administrador. Las gestiona el servidor desde sus propios módulos; un
 *   cerrojo escrito a mano deja muerto el trabajo que protege y el hash del
 *   token ICS de otro usuario da acceso a su calendario.
 * - Claves con regla: los permisos que ya gobiernan la pantalla que las usa.
 * - Resto: solo Administrador (tienen endpoints dedicados con su permiso).
 */

import { hasAnyPermission } from '../../middleware/auth.js';

export const ACCESO = Object.freeze({
  PERMITIDO: 'permitido',
  DENEGADO: 'denegado',
  CERRADO: 'cerrado',
});

const SOLO_ADMIN = Object.freeze([]);
const SOLO_PROPIO = 'propio';

const CLAVES_CERRADAS = new Set([
  'tareas/arrastre_vencimiento',
  'tareas/avisos_vencimiento_cerrojo',
  'reuniones/cerrojo_pipeline',
  'mantenimiento/facturacion_lock',
  'compras/facturacion_lock',
  'compras/facturacion_rappel_lock',
  'mayorista/secuencia',
  'proyectos/enlaces',
]);

const PREFIJOS_CERRADOS = [
  { pk: 'tareas', prefijoSk: 'ics_token#' },
  { pk: 'tareas', prefijoSk: 'calendar_pull#' },
];

/** Id de sincronización (SK) → permiso que la lanza en la pantalla de ajustes. */
const PERMISO_POR_SINCRONIZACION = {
  agora_productos: 'ajustes.sincronizaciones.agora_productos',
  agora_usuarios: 'ajustes.sincronizaciones.agora_usuarios',
  compras_proveedor: 'ajustes.sincronizaciones.compras_proveedor',
  closeouts: 'ajustes.sincronizaciones.closeouts',
  formas_pago: 'ajustes.sincronizaciones.closeouts',
  almacenes: 'ajustes.sincronizaciones.almacenes',
  ventas_producto: 'ajustes.sincronizaciones.ventas_producto',
  ventas_hora: 'ajustes.sincronizaciones.ventas_hora',
  empleados_factorial: 'ajustes.sincronizaciones.empleados',
};

const PERMISOS_LECTURA_SINCRONIZACIONES = [
  'ajustes.ver',
  ...new Set(Object.values(PERMISO_POR_SINCRONIZACION)),
];

/** Reglas que valen para cualquier SK del PK (la lectura no depende del SK). */
const REGLAS_POR_PK = {
  sincronizaciones: (sk) => ({
    leer: PERMISOS_LECTURA_SINCRONIZACIONES,
    escribir: [PERMISO_POR_SINCRONIZACION[sk] ?? 'ajustes.ver'],
  }),
  RATIO_HORAS_LOCAL: () => ({ leer: ['rrhh.horas'], escribir: ['rrhh.horas'] }),
  AGRUPACION_OBJETIVOS: () => ({
    leer: ['objetivos.ver', 'rrhh.horas'],
    escribir: ['objetivos.ver', 'rrhh.horas'],
  }),
};

const REGLAS_POR_CLAVE = {
  // El % de beneficio se aplica en todas las pantallas de pedidos (incluido el
  // modal de nuevo pedido del almacén) y el €/h en RRHH → Horas por facturación.
  'personalizacion/app': {
    leer: ['ajustes.ver', 'pedidos.ver', 'pedidos.ver_completados', 'pedidos.preparar', 'compras.ver', 'rrhh.horas'],
    escribir: ['ajustes.ver'],
  },
  'informes/informe_diario': { leer: ['ajustes.ver'], escribir: ['ajustes.ver'] },
  'planning_dia/enlaces': { leer: ['planning_dia.ver', 'ajustes.ver'], escribir: ['ajustes.ver'] },
  'mantenimiento/desplazamiento': { leer: ['ajustes.ver', 'mantenimiento.ver'], escribir: ['ajustes.ver'] },
  'mantenimiento/facturacion': {
    leer: ['ajustes.ver', 'mantenimiento.facturar'],
    escribir: ['mantenimiento.facturar'],
  },
  'compras/facturacion': { leer: ['ajustes.ver', 'compras.facturar'], escribir: ['compras.facturar'] },
};

const REGLA_FAVORITOS = { leer: SOLO_PROPIO, escribir: SOLO_PROPIO };
const REGLA_SOLO_ADMIN = { leer: SOLO_ADMIN, escribir: SOLO_ADMIN };

function esAdministrador(user) {
  return user?.rol === 'Administrador';
}

export function esAjusteCerrado(pk, sk) {
  const pkTexto = String(pk ?? '');
  const skTexto = String(sk ?? '');
  const skMinusculas = skTexto.toLowerCase();
  if (skMinusculas.includes('lock') || skMinusculas.includes('cerrojo')) return true;
  if (CLAVES_CERRADAS.has(`${pkTexto}/${skTexto}`)) return true;
  return PREFIJOS_CERRADOS.some((r) => r.pk === pkTexto && skTexto.startsWith(r.prefijoSk));
}

/** True si la lectura de todo el PK se decide con una sola regla (no hay que filtrar por SK). */
export function lecturaDependeSoloDelPk(pk) {
  return Object.hasOwn(REGLAS_POR_PK, String(pk ?? ''));
}

function reglaDe(pk, sk) {
  const pkTexto = String(pk ?? '');
  const skTexto = String(sk ?? '');
  if (Object.hasOwn(REGLAS_POR_PK, pkTexto)) return REGLAS_POR_PK[pkTexto](skTexto);
  if (pkTexto === 'favoritos') return REGLA_FAVORITOS;
  return REGLAS_POR_CLAVE[`${pkTexto}/${skTexto}`] ?? REGLA_SOLO_ADMIN;
}

async function cumple(permisos, user, sk) {
  if (!user) return false;
  if (permisos === SOLO_PROPIO) {
    return esAdministrador(user) || String(sk ?? '') === String(user.sub ?? '');
  }
  if (permisos.length === 0) return esAdministrador(user);
  return hasAnyPermission(user, ...permisos);
}

async function acceso(pk, sk, user, operacion) {
  if (esAjusteCerrado(pk, sk)) return ACCESO.CERRADO;
  const permisos = reglaDe(pk, sk)[operacion];
  return (await cumple(permisos, user, sk)) ? ACCESO.PERMITIDO : ACCESO.DENEGADO;
}

export function accesoLecturaAjuste(pk, sk, user) {
  return acceso(pk, sk, user, 'leer');
}

export function accesoEscrituraAjuste(pk, sk, user) {
  return acceso(pk, sk, user, 'escribir');
}

/** Lectura de un PK con regla común (ver `lecturaDependeSoloDelPk`). */
export async function puedeLeerPk(pk, user) {
  return cumple(reglaDe(pk, '').leer, user, '');
}
