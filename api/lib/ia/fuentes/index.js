/**
 * Registro de fuentes de datos del framework de Informes IA.
 *
 * Añadir una fuente nueva = crear su módulo en esta carpeta y registrarlo aquí
 * (más su permiso en `app/(app)/permisos.tsx` y `api/ROLES-PERMISOS.md`).
 */
import { objetivosMes } from './objetivosMes.js';
import { comprasVariaciones } from './comprasVariaciones.js';
import { ventasHora } from './ventasHora.js';
import { diaADia } from './diaADia.js';
import { ventasPorArticulo } from './ventasPorArticulo.js';

const FUENTES = [objetivosMes, comprasVariaciones, ventasHora, diaADia, ventasPorArticulo];

const FUENTES_POR_CLAVE = new Map(FUENTES.map((f) => [f.clave, f]));

/** Devuelve la fuente por su clave, o null. */
export function getFuente(clave) {
  return FUENTES_POR_CLAVE.get(clave) || null;
}

/** Metadatos públicos de una fuente (sin la función). */
export function fuenteMeta(f) {
  return {
    clave: f.clave,
    nombre: f.nombre,
    descripcion: f.descripcion,
    permiso: f.permiso,
    parametros: f.parametros || [],
  };
}

/** Lista de todas las fuentes (metadatos). */
export function listarFuentes() {
  return FUENTES.map(fuenteMeta);
}

export { FUENTES };
